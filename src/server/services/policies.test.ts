import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { evaluateLimits, shouldEmitAlert } from './policies.js';
import type { KeyUsageSummary } from '../../shared/types.js';

function summary(partial: Partial<KeyUsageSummary>): KeyUsageSummary {
  return {
    keyId: 'a', name: 'A', keyMasked: 'sk-…', isActive: true, status: 'ok', statusReason: 'Healthy',
    windowStart: '2026-01-01T00:00:00.000Z', windowEnd: null, resetPolicy: 'manual', expiresAt: null,
    tokenLimit: 100, actionOnLimit: 'alert', allowFinalFallback: true, usageMultiplier: 1, usageMultiplierEffectiveAt: null,
    actualPrompt: 0, actualCompletion: 0, actualTotal: 0, dedupedRequests: 1, duplicateRequests: 0, duplicateTokens: 0,
    req: 1, prompt: 0, completion: 0, total: 0, cost: 0,
    percentOfLimit: 0, firstUsageAt: null, lastUsageAt: null, models: {}, modelUsage: [], ...partial
  };
}

describe('evaluateLimits', () => {
  it('emits quota and expiry events', () => {
    const events = evaluateLimits([summary({ total: 120, expiresAt: '2026-01-01T00:00:00.000Z' })], '2026-01-02T00:00:00.000Z');
    expect(events.map(e => e.fingerprint)).toEqual(['expired:2026-01-01T00:00:00.000Z', 'quota:2026-01-01T00:00:00.000Z:100']);
  });

  it('dedupes alerts by fingerprint', () => {
    const db = new Database(':memory:');
    migrate(db);
    const event = evaluateLimits([summary({ total: 120 })])[0];
    expect(shouldEmitAlert(db, event)).toBe(true);
    expect(shouldEmitAlert(db, event)).toBe(false);
  });
});
