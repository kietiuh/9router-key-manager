import type Database from 'better-sqlite3';
import type { KeyUsageSummary } from '../../shared/types.js';

export type LimitEvent = {
  keyId: string;
  name: string;
  action: 'alert' | 'disable';
  message: string;
};

export function evaluateLimits(summaries: KeyUsageSummary[]): LimitEvent[] {
  const events: LimitEvent[] = [];
  for (const s of summaries) {
    if (!s.tokenLimit || s.total < s.tokenLimit) continue;
    if (s.actionOnLimit === 'none') continue;
    events.push({
      keyId: s.keyId,
      name: s.name,
      action: s.actionOnLimit === 'disable' ? 'disable' : 'alert',
      message: `${s.name} reached quota ${s.total}/${s.tokenLimit} tokens`
    });
  }
  return events;
}

export function writeAudit(db: Database.Database, keyId: string, action: string, message: string): void {
  db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, action, message);
}
