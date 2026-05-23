import type Database from 'better-sqlite3';
import type { KeyUsageSummary } from '../../shared/types.js';
import { atomicEnableApiKey, type ToggleResult } from './atomic9router.js';
import { writeAudit } from './policies.js';

export type QuotaUnlockResult =
  | { unlocked: true; reason: 'policy_allows'; enableResult?: ToggleResult }
  | { unlocked: false; reason: 'not_locked' | 'expired' | 'still_over_limit' };

export function maybeUnlockQuotaLockout(
  db: Database.Database,
  summary: KeyUsageSummary,
  options: { baseDir?: string; hardDisable?: boolean; now?: Date } = {},
): QuotaUnlockResult {
  const row = db.prepare('SELECT key_id FROM auto_disabled_keys WHERE key_id = ?').get(summary.keyId);
  if (!row) return { unlocked: false, reason: 'not_locked' };

  const nowIso = (options.now ?? new Date()).toISOString();
  if (summary.expiresAt && summary.expiresAt <= nowIso) return { unlocked: false, reason: 'expired' };

  if (summary.actionOnLimit === 'disable' && summary.tokenLimit != null && summary.total >= summary.tokenLimit) {
    return { unlocked: false, reason: 'still_over_limit' };
  }

  const enableResult = options.hardDisable && summary.isActive === false
    ? atomicEnableApiKey(summary.keyId, options.baseDir, options.now)
    : undefined;
  db.prepare('DELETE FROM auto_disabled_keys WHERE key_id = ?').run(summary.keyId);
  const limitText = summary.tokenLimit == null ? 'unlimited' : String(summary.tokenLimit);
  writeAudit(db, summary.keyId, 'quota.unlock', `${summary.name} quota policy now allows usage ${summary.total}/${limitText}; cleared quota lockout`);
  return { unlocked: true, reason: 'policy_allows', enableResult };
}
