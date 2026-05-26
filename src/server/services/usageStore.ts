import Database from 'better-sqlite3';
import type { UsageRecord } from '../../shared/types.js';

function tokenTotal(r: UsageRecord): number {
  const t = r.tokens ?? {};
  return t.total_tokens ?? ((t.prompt_tokens ?? 0) + (t.completion_tokens ?? 0));
}

export function usageSignature(r: UsageRecord): string {
  const t = r.tokens ?? {};
  return [
    r.apiKey ?? '',
    (r as any).provider ?? '',
    (r as any).connectionId ?? '',
    r.timestamp,
    r.model ?? '',
    t.prompt_tokens ?? 0,
    t.completion_tokens ?? 0,
    t.total_tokens ?? ''
  ].join('|');
}

export function ingestUsageHistory(db: Database.Database, rows: UsageRecord[]): number {
  const stmt = db.prepare(`INSERT OR IGNORE INTO usage_events (
    signature, api_key, model, provider, connection_id, timestamp, cost,
    prompt_tokens, completion_tokens, total_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction((items: UsageRecord[]) => {
    let inserted = 0;
    for (const r of items) {
      if (!r.timestamp) continue;
      const t = r.tokens ?? {};
      const res = stmt.run(
        usageSignature(r), r.apiKey ?? null, r.model ?? null, (r as any).provider ?? null, (r as any).connectionId ?? null, r.timestamp, r.cost ?? null,
        t.prompt_tokens ?? null, t.completion_tokens ?? null, tokenTotal(r),
        t.cache_read_input_tokens ?? null, t.cache_creation_input_tokens ?? null, t.reasoning_tokens ?? null, JSON.stringify(r)
      );
      inserted += Number(res.changes || 0);
    }
    return inserted;
  });
  return tx(rows);
}

export function recordSyntheticUsage(db: Database.Database, r: UsageRecord & { signature?: string }): string {
  const t = r.tokens ?? {};
  const signature = r.signature ?? usageSignature(r);
  db.prepare(`INSERT OR IGNORE INTO usage_events (
    signature, api_key, model, provider, connection_id, timestamp, cost,
    prompt_tokens, completion_tokens, total_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    signature, r.apiKey ?? null, r.model ?? null, (r as any).provider ?? null, (r as any).connectionId ?? null, r.timestamp, r.cost ?? null,
    t.prompt_tokens ?? null, t.completion_tokens ?? null, tokenTotal(r),
    t.cache_read_input_tokens ?? null, t.cache_creation_input_tokens ?? null, t.reasoning_tokens ?? null, JSON.stringify(r)
  );
  return signature;
}

type StoredUsageRow = {
  api_key: string | null;
  model: string | null;
  provider: string | null;
  connection_id: string | null;
  timestamp: string;
  cost: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_tokens: number | null;
};

export type StoredUsageKeyFilter = {
  apiKey: string;
  sinceIso?: string | null;
};

const storedUsageSelect = `SELECT api_key, model, provider, connection_id, timestamp, cost, prompt_tokens, completion_tokens, total_tokens, cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens FROM usage_events`;

function rowToUsageRecord(row: StoredUsageRow): UsageRecord {
  const tokens: NonNullable<UsageRecord['tokens']> = {};
  if (row.prompt_tokens != null) tokens.prompt_tokens = Number(row.prompt_tokens);
  if (row.completion_tokens != null) tokens.completion_tokens = Number(row.completion_tokens);
  if (row.total_tokens != null) tokens.total_tokens = Number(row.total_tokens);
  if (row.cache_read_input_tokens != null) tokens.cache_read_input_tokens = Number(row.cache_read_input_tokens);
  if (row.cache_creation_input_tokens != null) tokens.cache_creation_input_tokens = Number(row.cache_creation_input_tokens);
  if (row.reasoning_tokens != null) tokens.reasoning_tokens = Number(row.reasoning_tokens);
  return {
    apiKey: row.api_key ?? undefined,
    model: row.model ?? undefined,
    timestamp: row.timestamp,
    cost: row.cost ?? undefined,
    provider: row.provider ?? undefined,
    connectionId: row.connection_id ?? undefined,
    tokens,
  } as UsageRecord;
}

export function readStoredUsage(db: Database.Database, sinceIso?: string): UsageRecord[] {
  const rows = (sinceIso
    ? db.prepare(`${storedUsageSelect} WHERE timestamp >= ? ORDER BY timestamp ASC, id ASC`).all(sinceIso)
    : db.prepare(`${storedUsageSelect} ORDER BY timestamp ASC, id ASC`).all()) as StoredUsageRow[];
  return rows.map(rowToUsageRecord);
}

export function readStoredUsageForKeys(db: Database.Database, filters: StoredUsageKeyFilter[]): UsageRecord[] {
  const byKey = new Map<string, string | null | undefined>();
  for (const filter of filters) {
    if (!filter.apiKey) continue;
    const existing = byKey.get(filter.apiKey);
    if (!byKey.has(filter.apiKey) || !filter.sinceIso || (existing && filter.sinceIso < existing)) {
      byKey.set(filter.apiKey, filter.sinceIso);
    }
  }
  const allForKey = db.prepare(`${storedUsageSelect} WHERE api_key = ? ORDER BY timestamp ASC, id ASC`);
  const sinceForKey = db.prepare(`${storedUsageSelect} WHERE api_key = ? AND timestamp >= ? ORDER BY timestamp ASC, id ASC`);
  const rows: StoredUsageRow[] = [];
  for (const [apiKey, sinceIso] of byKey) {
    rows.push(...(sinceIso ? sinceForKey.all(apiKey, sinceIso) : allForKey.all(apiKey)) as StoredUsageRow[]);
  }
  return rows.map(rowToUsageRecord);
}

export function latestStoredUsageTimestamp(db: Database.Database): string | null {
  const row = db.prepare('SELECT MAX(timestamp) timestamp FROM usage_events').get() as { timestamp?: string | null };
  return row?.timestamp ?? null;
}
