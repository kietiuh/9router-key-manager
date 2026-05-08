import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { ingestUsageHistory, readStoredUsage } from './usageStore.js';

function db() { const d = new Database(':memory:'); migrate(d); return d; }

describe('usageStore', () => {
  it('keeps old usage after rolling source no longer contains it', () => {
    const d = db();
    const oldRow = { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { total_tokens: 10 } };
    const newRow = { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T01:00:00.000Z', tokens: { total_tokens: 20 } };
    expect(ingestUsageHistory(d, [oldRow])).toBe(1);
    expect(ingestUsageHistory(d, [newRow])).toBe(1);
    expect(readStoredUsage(d).map(r => r.timestamp)).toEqual([oldRow.timestamp, newRow.timestamp]);
  });

  it('dedupes repeated rolling history imports', () => {
    const d = db();
    const rows = [{ apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { prompt_tokens: 3, completion_tokens: 4 } }];
    expect(ingestUsageHistory(d, rows)).toBe(1);
    expect(ingestUsageHistory(d, rows)).toBe(0);
    expect(readStoredUsage(d)).toHaveLength(1);
  });
});
