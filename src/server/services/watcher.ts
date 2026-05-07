import type Database from 'better-sqlite3';
import { readApiKeys, readUsageHistory } from '../parsers/reader.js';
import { summarizeKeyUsage } from './usage.js';
import { evaluateLimits, shouldEmitAlert, writeAudit } from './policies.js';
import { atomicDisableApiKey, atomicEnableApiKey } from './atomic9router.js';
import { resolveWindow } from '../utils/time.js';

export type WatcherOptions = { baseDir?: string; hardDisable?: boolean };

function resolvedPolicies(db: Database.Database) {
  const events = db.prepare('SELECT key_id, multiplier, effective_at FROM usage_multiplier_events ORDER BY effective_at ASC, id ASC').all() as Array<{ key_id: string; multiplier: number; effective_at: string }>;
  const byKey = new Map<string, Array<{ multiplier: number; effective_at: string }>>();
  for (const e of events) {
    const arr = byKey.get(e.key_id) ?? [];
    arr.push({ multiplier: Number(e.multiplier), effective_at: e.effective_at });
    byKey.set(e.key_id, arr);
  }
  return (db.prepare('SELECT * FROM key_policies').all() as any[]).map(p => {
    const w = resolveWindow({ window_start: p.window_start, window_end: p.window_end, reset_policy: p.reset_policy });
    return { ...p, window_start: w.windowStart, window_end: w.windowEnd, reset_policy: w.resetPolicy, usage_multiplier_events: byKey.get(p.key_id) ?? [] };
  });
}

function restoreNewDailyWindows(db: Database.Database, keys: ReturnType<typeof readApiKeys>, policies: any[], options: WatcherOptions) {
  if (!options.hardDisable) return [];
  const restored: any[] = [];
  const keyById = new Map(keys.map(k => [k.id, k]));
  const policyById = new Map(policies.map(p => [p.key_id, p]));
  const rows = db.prepare('SELECT * FROM auto_disabled_keys').all() as any[];
  for (const row of rows) {
    const key = keyById.get(row.key_id);
    const policy = policyById.get(row.key_id);
    if (!key || !policy) continue;
    if (policy.reset_policy !== 'daily') continue;
    if (policy.window_start === row.disabled_for_window_start) continue;
    if (key.isActive === false) {
      const result = atomicEnableApiKey(row.key_id, options.baseDir);
      writeAudit(db, row.key_id, 'auto.enable', `Daily window reset; re-enabled key after quota lockout (${row.disabled_for_window_start} → ${policy.window_start})`);
      restored.push({ keyId: row.key_id, action: 'auto.enable', result });
    }
    db.prepare('DELETE FROM auto_disabled_keys WHERE key_id = ?').run(row.key_id);
  }
  return restored;
}

export function runWatcherOnce(db: Database.Database, options: WatcherOptions = {}) {
  const keys = readApiKeys(options.baseDir);
  const usage = readUsageHistory(options.baseDir);
  const policies = resolvedPolicies(db);
  const restored = restoreNewDailyWindows(db, keys, policies, options);
  const keysAfterRestore = restored.length ? readApiKeys(options.baseDir) : keys;
  const summaries = summarizeKeyUsage(keysAfterRestore, usage, policies);
  const events = evaluateLimits(summaries);
  const actions: any[] = [...restored];
  for (const event of events) {
    if (!shouldEmitAlert(db, event)) continue;
    writeAudit(db, event.keyId, event.action, event.message);
    if (event.action === 'disable' && options.hardDisable) {
      const result = atomicDisableApiKey(event.keyId, options.baseDir);
      const summary = summaries.find(s => s.keyId === event.keyId);
      if (summary?.resetPolicy === 'daily') {
        db.prepare('INSERT OR REPLACE INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)').run(event.keyId, summary.windowStart, event.message);
      }
      actions.push({ ...event, result });
    } else {
      actions.push(event);
    }
  }
  return { summaries, events, actions };
}

export function startWatcher(db: Database.Database, intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 60_000), options: WatcherOptions = {}) {
  const tick = () => {
    try { runWatcherOnce(db, options); } catch (error) { console.error('[watcher]', error); }
  };
  tick();
  return setInterval(tick, intervalMs);
}
