import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildQuotaErrorBody, computeRetryAfterSeconds, evaluateQuotaInterceptor, extractBearerToken } from './quotaInterceptor.js';

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE auto_disabled_keys (
      key_id TEXT PRIMARY KEY,
      disabled_for_window_start TEXT NOT NULL,
      reason TEXT
    );
    CREATE TABLE key_policies (
      key_id TEXT PRIMARY KEY,
      reset_policy TEXT
    );
  `);
  return db;
}

describe('extractBearerToken', () => {
  it('parses standard Bearer header', () => {
    expect(extractBearerToken('Bearer sk-abc.def_123')).toBe('sk-abc.def_123');
    expect(extractBearerToken('bearer SK-XYZ')).toBe('SK-XYZ');
  });

  it('returns null for non-bearer or missing values', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken(['Bearer keyA'])).toBe('keyA');
  });
});

describe('computeRetryAfterSeconds', () => {
  it('returns at least 1 second', () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    expect(computeRetryAfterSeconds('2026-05-18T10:00:00.000Z', now)).toBe(1);
    expect(computeRetryAfterSeconds('2026-05-18T09:00:00.000Z', now)).toBe(1);
  });

  it('returns seconds to reset', () => {
    const now = new Date('2026-05-18T10:00:00.000Z');
    expect(computeRetryAfterSeconds('2026-05-18T10:30:00.000Z', now)).toBe(1800);
  });

  it('falls back to 60s when resetAt is null', () => {
    expect(computeRetryAfterSeconds(null)).toBe(60);
  });
});

describe('evaluateQuotaInterceptor', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('returns blocked=false when no Authorization header', () => {
    const r = evaluateQuotaInterceptor({ db, authHeader: undefined, lookupKey: () => ({ id: 'x' }) });
    expect(r.blocked).toBe(false);
  });

  it('returns blocked=false when key not found in apiKeys', () => {
    const r = evaluateQuotaInterceptor({ db, authHeader: 'Bearer sk-unknown', lookupKey: () => undefined });
    expect(r.blocked).toBe(false);
  });

  it('returns blocked=false when key has no auto_disabled entry', () => {
    db.prepare('INSERT INTO key_policies (key_id, reset_policy) VALUES (?, ?)').run('k1', 'daily');
    const r = evaluateQuotaInterceptor({ db, authHeader: 'Bearer sk-active', lookupKey: () => ({ id: 'k1' }) });
    expect(r.blocked).toBe(false);
  });

  it('returns 429 with reason and resetAt when daily quota disabled', () => {
    db.prepare('INSERT INTO key_policies (key_id, reset_policy) VALUES (?, ?)').run('k2', 'daily');
    db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)')
      .run('k2', '2026-05-17T17:00:00.000Z', 'Key Q reached quota 1000/1000 tokens');
    const r = evaluateQuotaInterceptor({ db, authHeader: 'Bearer sk-q', lookupKey: () => ({ id: 'k2' }), now: new Date('2026-05-18T10:00:00.000Z') });
    expect(r).toMatchObject({ blocked: true, status: 429, keyId: 'k2', reason: 'Key Q reached quota 1000/1000 tokens' });
    if (r.blocked) {
      expect(r.resetAt).toBe('2026-05-18T17:00:00.000Z');
      expect(r.retryAfterSeconds).toBe(7 * 3600);
    }
  });

  it('returns 429 with null resetAt for manual reset policy', () => {
    db.prepare('INSERT INTO key_policies (key_id, reset_policy) VALUES (?, ?)').run('k3', 'manual');
    db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)')
      .run('k3', '2026-05-17T17:00:00.000Z', 'manual lockout');
    const r = evaluateQuotaInterceptor({ db, authHeader: 'Bearer sk-m', lookupKey: () => ({ id: 'k3' }) });
    if (!r.blocked) throw new Error('should be blocked');
    expect(r.resetAt).toBeNull();
    expect(r.retryAfterSeconds).toBe(60);
  });
});

describe('buildQuotaErrorBody', () => {
  it('serializes a friendly error body', () => {
    const body = buildQuotaErrorBody({ blocked: true, status: 429, retryAfterSeconds: 100, resetAt: '2026-05-18T17:00:00.000Z', reason: 'Key X over quota', keyId: 'k' });
    expect(body.error.type).toBe('rate_limit_exceeded');
    expect(body.error.code).toBe('daily_quota_exceeded');
    expect(body.error.reset_at).toBe('2026-05-18T17:00:00.000Z');
    expect(body.error.reason).toBe('Key X over quota');
  });
});
