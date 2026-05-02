import type Database from 'better-sqlite3';
import type { KeyUsageSummary } from '../../shared/types.js';

export type LimitEvent = {
  keyId: string;
  name: string;
  action: 'alert' | 'disable';
  message: string;
  fingerprint: string;
};

export function evaluateLimits(summaries: KeyUsageSummary[], nowIso = new Date().toISOString()): LimitEvent[] {
  const events: LimitEvent[] = [];
  for (const s of summaries) {
    if (s.expiresAt && s.expiresAt <= nowIso && s.isActive && s.actionOnLimit !== 'none') {
      events.push({
        keyId: s.keyId,
        name: s.name,
        action: s.actionOnLimit === 'disable' ? 'disable' : 'alert',
        message: `${s.name} expired at ${s.expiresAt}`,
        fingerprint: `expired:${s.expiresAt}`
      });
    }
    if (!s.tokenLimit || s.total < s.tokenLimit) continue;
    if (s.actionOnLimit === 'none') continue;
    const overBy = s.total - s.tokenLimit;
    events.push({
      keyId: s.keyId,
      name: s.name,
      action: s.actionOnLimit === 'disable' ? 'disable' : 'alert',
      message: `${s.name} reached quota ${s.total}/${s.tokenLimit} tokens (+${overBy})`,
      fingerprint: `quota:${s.windowStart}:${s.tokenLimit}`
    });
  }
  return events;
}

export function writeAudit(db: Database.Database, keyId: string, action: string, message: string): void {
  db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, action, message);
}

export function shouldEmitAlert(db: Database.Database, event: LimitEvent, nowIso = new Date().toISOString()): boolean {
  const existing = db.prepare('SELECT 1 FROM alert_state WHERE key_id = ? AND action = ? AND fingerprint = ?').get(event.keyId, event.action, event.fingerprint);
  if (existing) return false;
  db.prepare('INSERT INTO alert_state (key_id, action, fingerprint, last_seen_at) VALUES (?, ?, ?, ?)').run(event.keyId, event.action, event.fingerprint, nowIso);
  return true;
}
