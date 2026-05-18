import type Database from 'better-sqlite3';
import { endOfVietnamDayUtc, endOfVietnamMonthUtc } from '../utils/time.js';

export type AutoDisableSnapshot = {
  keyId: string;
  reason: string;
  disabledForWindowStart: string;
  resetAt: string | null;
};

export type QuotaInterceptResult = {
  blocked: true;
  status: 429;
  retryAfterSeconds: number;
  resetAt: string | null;
  reason: string;
  keyId: string;
} | {
  blocked: false;
};

const TOKEN_RE = /Bearer\s+([A-Za-z0-9._\-:+\/=]+)/i;

export function extractBearerToken(authHeader: string | string[] | undefined): string | null {
  if (!authHeader) return null;
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof value !== 'string') return null;
  const m = TOKEN_RE.exec(value.trim());
  return m ? m[1].trim() : null;
}

export type ApiKeyLookup = (token: string) => { id: string } | undefined;

export function readAutoDisableSnapshot(db: Database.Database, keyId: string): AutoDisableSnapshot | null {
  const row = db.prepare('SELECT key_id, reason, disabled_for_window_start FROM auto_disabled_keys WHERE key_id = ? ORDER BY disabled_for_window_start DESC LIMIT 1').get(keyId) as
    | { key_id: string; reason: string | null; disabled_for_window_start: string }
    | undefined;
  if (!row) return null;
  const policy = db.prepare('SELECT reset_policy FROM key_policies WHERE key_id = ?').get(keyId) as { reset_policy?: string | null } | undefined;
  const resetPolicy = (policy?.reset_policy ?? 'daily') as string;
  const resetAt = resetPolicy === 'daily' ? endOfVietnamDayUtc()
    : resetPolicy === 'monthly' ? endOfVietnamMonthUtc()
    : null;
  return { keyId: row.key_id, reason: row.reason ?? 'quota exceeded', disabledForWindowStart: row.disabled_for_window_start, resetAt };
}

export function computeRetryAfterSeconds(resetAt: string | null, now = new Date()): number {
  if (!resetAt) return 60;
  const diff = Math.ceil((new Date(resetAt).getTime() - now.getTime()) / 1000);
  return Math.max(1, diff);
}

export function evaluateQuotaInterceptor(opts: {
  db: Database.Database;
  authHeader: string | string[] | undefined;
  lookupKey: ApiKeyLookup;
  now?: Date;
}): QuotaInterceptResult {
  const token = extractBearerToken(opts.authHeader);
  if (!token) return { blocked: false };
  const key = opts.lookupKey(token);
  if (!key) return { blocked: false };
  const snap = readAutoDisableSnapshot(opts.db, key.id);
  if (!snap) return { blocked: false };
  const retryAfterSeconds = computeRetryAfterSeconds(snap.resetAt, opts.now);
  return {
    blocked: true,
    status: 429,
    retryAfterSeconds,
    resetAt: snap.resetAt,
    reason: snap.reason,
    keyId: snap.keyId,
  };
}

export function buildQuotaErrorBody(result: Extract<QuotaInterceptResult, { blocked: true }>) {
  const resetHuman = result.resetAt ? `Resets at ${result.resetAt}` : 'Resets after the current window ends';
  return {
    error: {
      message: `Daily quota exceeded for this key. ${resetHuman}.`,
      type: 'rate_limit_exceeded',
      code: 'daily_quota_exceeded',
      reset_at: result.resetAt,
      reason: result.reason,
    },
  };
}
