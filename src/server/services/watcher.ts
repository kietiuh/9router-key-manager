import type Database from 'better-sqlite3';
import { readApiKeys, readUsageHistory } from '../parsers/reader.js';
import { summarizeKeyUsage } from './usage.js';
import { evaluateLimits, shouldEmitAlert, writeAudit } from './policies.js';
import { atomicDisableApiKey } from './atomic9router.js';

export type WatcherOptions = { baseDir?: string; hardDisable?: boolean };

export function runWatcherOnce(db: Database.Database, options: WatcherOptions = {}) {
  const keys = readApiKeys(options.baseDir);
  const usage = readUsageHistory(options.baseDir);
  const policies = db.prepare('SELECT * FROM key_policies').all() as any[];
  const summaries = summarizeKeyUsage(keys, usage, policies);
  const events = evaluateLimits(summaries);
  const actions: any[] = [];
  for (const event of events) {
    if (!shouldEmitAlert(db, event)) continue;
    writeAudit(db, event.keyId, event.action, event.message);
    if (event.action === 'disable' && options.hardDisable) {
      const result = atomicDisableApiKey(event.keyId, options.baseDir);
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
