import type Database from 'better-sqlite3';
import { extractBearerToken } from './quotaInterceptor.js';

export type KeyAccessLookupResult = {
  id: string;
  isActive?: boolean;
};

export type KeyAccessLookup = (token: string) => KeyAccessLookupResult | undefined;

export type KeyAccessInterceptResult = {
  blocked: true;
  status: 403;
  code: 'key_expired';
  keyId: string;
  expiresAt: string;
} | {
  blocked: false;
};

export function readExpiredKey(db: Database.Database, keyId: string, nowIso = new Date().toISOString()): { expiresAt: string } | null {
  const row = db.prepare('SELECT expires_at FROM key_policies WHERE key_id = ? AND expires_at IS NOT NULL AND expires_at <= ?')
    .get(keyId, nowIso) as { expires_at?: string | null } | undefined;
  return row?.expires_at ? { expiresAt: row.expires_at } : null;
}

export function evaluateKeyAccessInterceptor(opts: {
  db: Database.Database;
  authHeader: string | string[] | undefined;
  lookupKey: KeyAccessLookup;
  nowIso?: string;
}): KeyAccessInterceptResult {
  const token = extractBearerToken(opts.authHeader);
  if (!token) return { blocked: false };
  const key = opts.lookupKey(token);
  if (!key) return { blocked: false };
  const expired = readExpiredKey(opts.db, key.id, opts.nowIso);
  if (!expired) return { blocked: false };
  return {
    blocked: true,
    status: 403,
    code: 'key_expired',
    keyId: key.id,
    expiresAt: expired.expiresAt,
  };
}

export function buildKeyExpiredErrorBody(result: Extract<KeyAccessInterceptResult, { blocked: true }>) {
  return {
    error: {
      message: `This API key expired at ${result.expiresAt}.`,
      type: 'permission_denied',
      code: 'key_expired',
      expires_at: result.expiresAt,
    },
  };
}
