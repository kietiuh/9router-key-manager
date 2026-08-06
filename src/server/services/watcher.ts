import type Database from 'better-sqlite3';
import { readApiKeys, readUsageHistorySince } from '../parsers/reader.js';
import { summarizeKeyUsage } from './usage.js';
import { ingestUsageHistory, readStoredUsageForKeys } from './usageStore.js';
import { evaluateLimits, shouldEmitAlert, writeAudit } from './policies.js';
import { atomicDisableApiKey, atomicEnableApiKey } from './atomic9router.js';
import { enqueueBotQuotaAlertJobs } from './botAlertQueue.js';
import { resolvedPolicies, usageFiltersForPolicies, usageImportSince } from './policyUsage.js';

export type WatcherOptions = { baseDir?: string; hardDisable?: boolean };

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

    const expired = !!policy.expires_at && policy.expires_at <= new Date().toISOString();
    if (expired) {
      writeAudit(db, row.key_id, 'auto.enable.skip', `Daily window reset but key is expired (${policy.expires_at}); keeping disabled (${row.disabled_for_window_start} → ${policy.window_start})`);
      continue;
    }

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
  const policies = resolvedPolicies(db);
  ingestUsageHistory(db, readUsageHistorySince(usageImportSince(db, Number(process.env.USAGE_REFRESH_OVERLAP_MS ?? 5 * 60_000)), options.baseDir));
  const usage = readStoredUsageForKeys(db, usageFiltersForPolicies(keys, policies));
  const restored = restoreNewDailyWindows(db, keys, policies, options);
  const keysAfterRestore = restored.length ? readApiKeys(options.baseDir) : keys;
  const summaries = summarizeKeyUsage(keysAfterRestore, usage, policies);
  const botAlertJobs = enqueueBotQuotaAlertJobs(db, summaries, keysAfterRestore);
  const events = evaluateLimits(summaries);
  const actions: any[] = [...restored];
  for (const event of events) {
    const shouldEmit = shouldEmitAlert(db, event);
    if (shouldEmit) writeAudit(db, event.keyId, event.action, event.message);
    if (event.action === 'disable' && options.hardDisable) {
      const summary = summaries.find(s => s.keyId === event.keyId);
      const alreadyAutoDisabled = summary?.resetPolicy === 'daily'
        ? !!db.prepare('SELECT 1 FROM auto_disabled_keys WHERE key_id = ? AND disabled_for_window_start = ?').get(event.keyId, summary.windowStart)
        : false;
      // Skip if the key was already auto-disabled for this window (#68 hardening).
      // Do NOT also check `summary.isActive` here: a monthly/manual key that was
      // turned off by an earlier watcher pass has no auto-restore path, so the
      // re-evaluation of the breach is what keeps the lockout durable across
      // future runs and ensures we re-emit the alert if the user re-enables
      // a still-over-quota key.
      if (!alreadyAutoDisabled) {
        const result = atomicDisableApiKey(event.keyId, options.baseDir);
        if (summary?.resetPolicy === 'daily') {
          db.prepare('INSERT OR REPLACE INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)').run(event.keyId, summary.windowStart, event.message);
        }
        actions.push({ ...event, result });
      } else if (shouldEmit) {
        actions.push(event);
      }
    } else if (shouldEmit) {
      actions.push(event);
    }
  }
  return { summaries, events, actions, botAlertJobs };
}

export function startWatcher(db: Database.Database, intervalMs = Number(process.env.WATCH_INTERVAL_MS ?? 60_000), options: WatcherOptions = {}) {
  const tick = () => {
    try { runWatcherOnce(db, options); } catch (error) { console.error('[watcher]', error); }
  };
  tick();
  return setInterval(tick, intervalMs);
}
