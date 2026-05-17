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
    t.total_tokens ?? '',
    r.cost ?? ''
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

export function readStoredUsage(db: Database.Database): UsageRecord[] {
  const rows = db.prepare('SELECT raw_json FROM usage_events ORDER BY timestamp ASC, id ASC').all() as Array<{ raw_json: string }>;
  return rows.map(r => JSON.parse(r.raw_json) as UsageRecord);
}
