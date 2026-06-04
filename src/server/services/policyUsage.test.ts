import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { ingestUsageHistory } from './usageStore.js';
import { resolvedPolicies, usageFiltersForPolicies, usageImportSince } from './policyUsage.js';

function db() {
  const d = new Database(':memory:');
  migrate(d);
  return d;
}

describe('policy usage helpers', () => {
  it('returns undefined import start when no usage has been stored', () => {
    const d = db();

    expect(usageImportSince(d, 5 * 60_000)).toBeUndefined();
  });

  it('overlaps the latest stored usage timestamp', () => {
    const d = db();
    ingestUsageHistory(d, [{
      apiKey: 'sk-a',
      model: 'm',
      timestamp: '2026-06-04T10:00:00.000Z',
      tokens: { total_tokens: 10 },
    }]);

    expect(usageImportSince(d, 5 * 60_000)).toBe('2026-06-04T09:55:00.000Z');
  });

  it('maps usage filters from key ids to policy windows', () => {
    const filters = usageFiltersForPolicies(
      [{ id: 'a', key: 'sk-a' }, { id: 'b', key: 'sk-b' }],
      [{ key_id: 'a', window_start: '2026-06-04T00:00:00.000Z' }],
    );

    expect(filters).toEqual([
      { apiKey: 'sk-a', sinceIso: '2026-06-04T00:00:00.000Z' },
      { apiKey: 'sk-b', sinceIso: undefined },
    ]);
  });

  it('resolves policy windows and attaches multiplier events', () => {
    const d = db();
    d.prepare('INSERT INTO key_policies (key_id, name, window_start, reset_policy, usage_multiplier) VALUES (?, ?, ?, ?, ?)')
      .run('a', 'A', '2026-06-04T00:00:00.000Z', 'manual', 2);
    d.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)')
      .run('a', 2, '2026-06-04T01:00:00.000Z');

    const [policy] = resolvedPolicies(d, { imageDailyUsageForKey: keyId => keyId === 'a' ? 3 : 0 });

    expect(policy).toMatchObject({
      key_id: 'a',
      name: 'A',
      window_start: '2026-06-04T00:00:00.000Z',
      window_end: null,
      reset_policy: 'manual',
      usage_multiplier: 2,
      image_daily_used: 3,
      usage_multiplier_events: [{ multiplier: 2, effective_at: '2026-06-04T01:00:00.000Z' }],
    });
  });
});
