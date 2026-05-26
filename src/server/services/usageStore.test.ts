import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { ingestUsageHistory, latestStoredUsageTimestamp, readStoredUsage, readStoredUsageForKeys, recordSyntheticUsage, usageSignature } from './usageStore.js';

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

  it('dedupes imports when total tokens are implied by prompt and completion', () => {
    const d = db();
    const first = { apiKey: 'sk-a', provider: 'p', connectionId: 'c', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    const second = { ...first, tokens: { prompt_tokens: 3, completion_tokens: 4 } };

    expect(usageSignature(first)).toBe(usageSignature(second));
    expect(ingestUsageHistory(d, [first])).toBe(1);
    expect(ingestUsageHistory(d, [second])).toBe(0);
    expect(readStoredUsage(d)).toHaveLength(1);
  });

  it('dedupes logical usage rows even when rolling cost changes', () => {
    const d = db();
    const first = { apiKey: 'sk-a', provider: 'p', connectionId: 'c', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', cost: 0.1, tokens: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    const second = { ...first, cost: 0.2 };

    expect(usageSignature(first)).toBe(usageSignature(second));
    expect(ingestUsageHistory(d, [first])).toBe(1);
    expect(ingestUsageHistory(d, [second])).toBe(0);
    expect(readStoredUsage(d)).toHaveLength(1);
  });

  it('stores synthetic image usage as normal key usage', () => {
    const d = db();
    const signature = recordSyntheticUsage(d, { signature: 'synthetic-image|x', apiKey: 'sk-img', model: 'cx/gpt-5.4-image', timestamp: '2026-05-08T02:00:00.000Z', tokens: { prompt_tokens: 10, completion_tokens: 20000, total_tokens: 20010 } } as any);
    recordSyntheticUsage(d, { signature, apiKey: 'sk-img', model: 'cx/gpt-5.4-image', timestamp: '2026-05-08T02:00:00.000Z', tokens: { prompt_tokens: 10, completion_tokens: 20000, total_tokens: 20010 } } as any);
    expect(readStoredUsage(d)).toHaveLength(1);
    expect(readStoredUsage(d)[0].tokens?.total_tokens).toBe(20010);
  });

  it('reads normalized usage columns without parsing raw json', () => {
    const d = db();
    const row = { apiKey: 'sk-a', provider: 'p', connectionId: 'c', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', cost: 0.2, tokens: { prompt_tokens: 3, completion_tokens: 4, cache_read_input_tokens: 2 } };
    expect(ingestUsageHistory(d, [row] as any)).toBe(1);
    d.prepare('UPDATE usage_events SET raw_json = ?').run('{broken json');
    const stored = readStoredUsage(d)[0] as any;
    expect(stored.apiKey).toBe('sk-a');
    expect(stored.provider).toBe('p');
    expect(stored.connectionId).toBe('c');
    expect(stored.tokens.prompt_tokens).toBe(3);
    expect(stored.tokens.cache_read_input_tokens).toBe(2);
  });

  it('supports incremental reads by timestamp', () => {
    const d = db();
    const rows = [
      { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { total_tokens: 10 } },
      { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T01:00:00.000Z', tokens: { total_tokens: 20 } },
    ];
    ingestUsageHistory(d, rows);
    expect(latestStoredUsageTimestamp(d)).toBe('2026-05-08T01:00:00.000Z');
    expect(readStoredUsage(d, '2026-05-08T00:30:00.000Z').map(r => r.timestamp)).toEqual([rows[1].timestamp]);
  });

  it('reads selected keys from each key window', () => {
    const d = db();
    ingestUsageHistory(d, [
      { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { total_tokens: 10 } },
      { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-08T01:00:00.000Z', tokens: { total_tokens: 20 } },
      { apiKey: 'sk-b', model: 'm', timestamp: '2026-05-08T00:00:00.000Z', tokens: { total_tokens: 30 } },
      { apiKey: 'sk-c', model: 'm', timestamp: '2026-05-08T01:00:00.000Z', tokens: { total_tokens: 40 } },
    ]);

    const rows = readStoredUsageForKeys(d, [
      { apiKey: 'sk-a', sinceIso: '2026-05-08T00:30:00.000Z' },
      { apiKey: 'sk-b', sinceIso: '2026-05-08T00:00:00.000Z' },
    ]);

    expect(rows.map(r => `${r.apiKey}:${r.timestamp}`)).toEqual([
      'sk-a:2026-05-08T01:00:00.000Z',
      'sk-b:2026-05-08T00:00:00.000Z',
    ]);
  });
});
