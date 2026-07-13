import type Database from 'better-sqlite3';

export type UsageEventRow = {
  id: number;
  timestamp: string;
  model: string | null;
  provider: string | null;
  connectionId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cost: number | null;
};

export type CacheFilter = 'any' | 'read' | 'write' | 'none';

export type Cursor = { ts: string; id: number };

export type UsageEventsQuery = {
  apiKey: string;
  fromIso: string;
  toIso: string;
  model?: string | null;
  provider?: string | null;
  cache?: CacheFilter;
  cursor?: Cursor | null;
  /** Page size is validated at the HTTP boundary (50|100|200). Service accepts any positive int for testability. */
  pageSize: number;
};

export type UsageEventsPage = {
  rows: UsageEventRow[];
  nextCursor: Cursor | null;
  hasMore: boolean;
};

type RawRow = {
  id: number;
  timestamp: string;
  model: string | null;
  provider: string | null;
  connection_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost: number | null;
};

function mapRow(r: RawRow): UsageEventRow {
  return {
    id: r.id,
    timestamp: r.timestamp,
    model: r.model,
    provider: r.provider,
    connectionId: r.connection_id,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    cacheReadTokens: r.cache_read_input_tokens,
    cacheCreationTokens: r.cache_creation_input_tokens,
    cost: r.cost,
  };
}

export function defaultRange(): { fromIso: string; toIso: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`).toString('base64url');
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseCursor(input?: string | null): Cursor | null {
  if (!input) return null;
  let raw: string;
  try {
    raw = Buffer.from(input, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const idx = raw.lastIndexOf('|');
  if (idx < 0) return null;
  const ts = raw.slice(0, idx);
  const idStr = raw.slice(idx + 1);
  const id = Number(idStr);
  if (!ISO_RE.test(ts) || !Number.isInteger(id) || id <= 0) return null;
  return { ts, id };
}

export function listUsageEventsForKey(db: Database.Database, query: UsageEventsQuery): UsageEventsPage {
  const cache = query.cache ?? 'any';
  const cursor = query.cursor ?? null;
  const limit = query.pageSize + 1; // overfetch to detect hasMore

  const stmt = db.prepare(`
    SELECT id, timestamp, model, provider, connection_id,
           prompt_tokens, completion_tokens, total_tokens,
           cache_read_input_tokens, cache_creation_input_tokens, cost
    FROM usage_events
    WHERE api_key = ?
      AND timestamp >= ? AND timestamp <= ?
      AND (? IS NULL OR model = ?)
      AND (? IS NULL OR provider = ?)
      AND (
        ? = 'any'
        OR (? = 'read'  AND COALESCE(cache_read_input_tokens, 0)     > 0)
        OR (? = 'write' AND COALESCE(cache_creation_input_tokens, 0) > 0)
        OR (? = 'none'  AND COALESCE(cache_read_input_tokens, 0) = 0
                       AND COALESCE(cache_creation_input_tokens, 0) = 0)
      )
      AND (? IS NULL OR (timestamp < ? OR (timestamp = ? AND id < ?)))
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);
  const raw = stmt.all(
    query.apiKey,
    query.fromIso,
    query.toIso,
    query.model ?? null,
    query.model ?? null,
    query.provider ?? null,
    query.provider ?? null,
    cache,
    cache,
    cache,
    cache,
    cursor ? cursor.ts : null,
    cursor ? cursor.ts : null,
    cursor ? cursor.ts : null,
    cursor ? cursor.id : null,
    limit,
  ) as RawRow[];

  const hasMore = raw.length > query.pageSize;
  const kept = hasMore ? raw.slice(0, query.pageSize) : raw;
  const last = kept[kept.length - 1];
  return {
    rows: kept.map(mapRow),
    nextCursor: hasMore && last ? { ts: last.timestamp, id: last.id } : null,
    hasMore,
  };
}

export function distinctModelsForKey(
  db: Database.Database,
  query: { apiKey: string; fromIso: string; toIso: string; limit?: number },
): string[] {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 200);
  const rows = db
    .prepare(
      `SELECT DISTINCT model FROM usage_events
       WHERE api_key = ? AND model IS NOT NULL AND timestamp >= ? AND timestamp <= ?
       ORDER BY model ASC LIMIT ?`,
    )
    .all(query.apiKey, query.fromIso, query.toIso, limit) as Array<{ model: string }>;
  return rows.map(r => r.model);
}
