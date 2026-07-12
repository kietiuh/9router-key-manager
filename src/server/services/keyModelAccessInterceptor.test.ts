import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildKeyModelNotAllowedErrorBody,
  evaluateKeyModelAccessInterceptor,
  readAllowedModels,
} from './keyModelAccessInterceptor.js';

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE key_policies (
      key_id TEXT PRIMARY KEY,
      allowed_models_json TEXT
    );
  `);
  return db;
}

describe('readAllowedModels', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('returns [] when the column is NULL', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', null);
    expect(readAllowedModels(db, 'k1')).toEqual([]);
  });

  it('returns [] when the key has no policy row', () => {
    expect(readAllowedModels(db, 'missing')).toEqual([]);
  });

  it('returns a trimmed, deduped list for valid JSON', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['  claude-opus-4.8 ', 'gpt-5.5', 'claude-opus-4.8', '']));
    expect(readAllowedModels(db, 'k1')).toEqual(['claude-opus-4.8', 'gpt-5.5']);
  });

  it('returns [] on invalid JSON', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', 'not-json');
    expect(readAllowedModels(db, 'k1')).toEqual([]);
  });
});

describe('evaluateKeyModelAccessInterceptor', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('does not block when Authorization is missing', () => {
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: undefined, rawModel: 'x', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when the token is unknown', () => {
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk-missing', rawModel: 'x', lookupKey: () => undefined }).blocked).toBe(false);
  });

  it('does not block when rawModel is undefined', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8']));
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: undefined, lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when the whitelist is empty', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', null);
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: 'anything', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when rawModel is in the whitelist', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8']));
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: 'claude-opus-4.8', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('blocks when rawModel is not in the whitelist', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8', 'gpt-5.5']));
    const result = evaluateKeyModelAccessInterceptor({
      db,
      authHeader: 'Bearer sk',
      rawModel: 'claude-haiku-5',
      lookupKey: () => ({ id: 'k1' }),
    });
    expect(result).toEqual({
      blocked: true,
      status: 403,
      code: 'model_not_allowed',
      keyId: 'k1',
      model: 'claude-haiku-5',
      allowedModels: ['claude-opus-4.8', 'gpt-5.5'],
    });
  });
});

describe('buildKeyModelNotAllowedErrorBody', () => {
  it('serializes an OpenAI-compatible model_not_allowed error', () => {
    const body = buildKeyModelNotAllowedErrorBody({
      blocked: true,
      status: 403,
      code: 'model_not_allowed',
      keyId: 'k1',
      model: 'claude-haiku-5',
      allowedModels: ['claude-opus-4.8'],
    });
    expect(body.error).toEqual({
      message: "Model 'claude-haiku-5' is not allowed for this API key.",
      type: 'permission_denied',
      code: 'model_not_allowed',
      model: 'claude-haiku-5',
      allowed_models: ['claude-opus-4.8'],
    });
  });
});
