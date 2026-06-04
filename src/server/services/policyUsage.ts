import type Database from 'better-sqlite3';
import type { ApiKeyRecord } from '../../shared/types.js';
import { resolveWindow } from '../utils/time.js';
import { latestStoredUsageTimestamp } from './usageStore.js';
import type { Policy } from './usage.js';

export type PolicyUsageOptions = {
  imageDailyUsageForKey?: (keyId: string) => number;
};

export type ResolvedPolicy = Policy & {
  key_id: string;
  window_start: string;
  reset_policy: NonNullable<Policy['reset_policy']>;
  usage_multiplier_events: NonNullable<Policy['usage_multiplier_events']>;
};

export function resolvedPolicies(db: Database.Database, options: PolicyUsageOptions = {}): ResolvedPolicy[] {
  const events = db.prepare('SELECT key_id, multiplier, effective_at FROM usage_multiplier_events ORDER BY effective_at ASC, id ASC').all() as Array<{ key_id: string; multiplier: number; effective_at: string }>;
  const byKey = new Map<string, Array<{ multiplier: number; effective_at: string }>>();
  for (const e of events) {
    const arr = byKey.get(e.key_id) ?? [];
    arr.push({ multiplier: Number(e.multiplier), effective_at: e.effective_at });
    byKey.set(e.key_id, arr);
  }
  return (db.prepare('SELECT * FROM key_policies').all() as any[]).map(p => {
    const w = resolveWindow({ window_start: p.window_start, window_end: p.window_end, reset_policy: p.reset_policy });
    const imageDailyUsed = options.imageDailyUsageForKey?.(p.key_id);
    return {
      ...p,
      ...(imageDailyUsed === undefined ? {} : { image_daily_used: imageDailyUsed }),
      window_start: w.windowStart,
      window_end: w.windowEnd,
      reset_policy: w.resetPolicy,
      usage_multiplier_events: byKey.get(p.key_id) ?? [],
    };
  });
}

export function usageImportSince(db: Database.Database, overlapMs: number): string | undefined {
  const latest = latestStoredUsageTimestamp(db);
  if (!latest) return undefined;
  const latestMs = Date.parse(latest);
  if (!Number.isFinite(latestMs)) return latest;
  return new Date(Math.max(0, latestMs - overlapMs)).toISOString();
}

export function usageFiltersForPolicies(keys: Array<Pick<ApiKeyRecord, 'id' | 'key'>>, policies: Array<{ key_id: string; window_start?: string | null }>) {
  const policyById = new Map(policies.map(policy => [policy.key_id, policy]));
  return keys.map(key => ({ apiKey: key.key, sinceIso: policyById.get(key.id)?.window_start }));
}
