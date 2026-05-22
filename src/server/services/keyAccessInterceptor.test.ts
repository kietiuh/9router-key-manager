import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildKeyExpiredErrorBody, evaluateKeyAccessInterceptor, readExpiredKey } from './keyAccessInterceptor.js';

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE key_policies (
      key_id TEXT PRIMARY KEY,
      expires_at TEXT
    );
  `);
  return db;
}

describe('readExpiredKey', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('returns null when the key has no expiration', () => {
    db.prepare('INSERT INTO key_policies (key_id, expires_at) VALUES (?, ?)').run('k1', null);
    expect(readExpiredKey(db, 'k1', '2026-05-22T10:00:00.000Z')).toBeNull();
  });

  it('returns null when the expiration is in the future', () => {
    db.prepare('INSERT INTO key_policies (key_id, expires_at) VALUES (?, ?)').run('k1', '2026-05-23T00:00:00.000Z');
    expect(readExpiredKey(db, 'k1', '2026-05-22T10:00:00.000Z')).toBeNull();
  });

  it('returns the expiration when the key is expired', () => {
    db.prepare('INSERT INTO key_policies (key_id, expires_at) VALUES (?, ?)').run('k1', '2026-05-22T09:00:00.000Z');
    expect(readExpiredKey(db, 'k1', '2026-05-22T10:00:00.000Z')).toEqual({ expiresAt: '2026-05-22T09:00:00.000Z' });
  });
});

describe('evaluateKeyAccessInterceptor', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('does not block when Authorization is missing or key is unknown', () => {
    expect(evaluateKeyAccessInterceptor({ db, authHeader: undefined, lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
    expect(evaluateKeyAccessInterceptor({ db, authHeader: 'Bearer sk-missing', lookupKey: () => undefined }).blocked).toBe(false);
  });

  it('blocks expired keys with 403 key_expired', () => {
    db.prepare('INSERT INTO key_policies (key_id, expires_at) VALUES (?, ?)').run('k1', '2026-05-22T09:00:00.000Z');
    const result = evaluateKeyAccessInterceptor({
      db,
      authHeader: 'Bearer sk-expired',
      lookupKey: () => ({ id: 'k1', isActive: false }),
      nowIso: '2026-05-22T10:00:00.000Z',
    });
    expect(result).toEqual({ blocked: true, status: 403, code: 'key_expired', keyId: 'k1', expiresAt: '2026-05-22T09:00:00.000Z' });
  });
});

describe('buildKeyExpiredErrorBody', () => {
  it('serializes an OpenAI-compatible expired key error', () => {
    const body = buildKeyExpiredErrorBody({ blocked: true, status: 403, code: 'key_expired', keyId: 'k1', expiresAt: '2026-05-22T09:00:00.000Z' });
    expect(body.error).toEqual({
      message: 'This API key expired at 2026-05-22T09:00:00.000Z.',
      type: 'permission_denied',
      code: 'key_expired',
      expires_at: '2026-05-22T09:00:00.000Z',
    });
  });
});
