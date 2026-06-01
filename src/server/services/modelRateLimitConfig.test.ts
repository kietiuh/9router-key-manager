import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { createModelRateLimitConfigStore, getModelRateLimitConfig, saveModelRateLimitConfig } from './modelRateLimitConfig.js';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('model rate limit config', () => {
  it('defaults disabled with no rules', () => {
    const db = memDb();

    expect(getModelRateLimitConfig(db)).toEqual({ enabled: false, rules: [] });
  });

  it('saves normalized rules in app settings', () => {
    const db = memDb();
    const cfg = saveModelRateLimitConfig(db, {
      enabled: true,
      rules: [
        { model: ' v4/gpt-5.5 ', enabled: true, rpm: 12, queueLimit: 25, maxQueueWaitMs: 180_000 },
        { model: '   ', enabled: true, rpm: 1, queueLimit: 1, maxQueueWaitMs: 1_000 },
        { model: 'cx/gpt-5.5', enabled: false, rpm: -1, queueLimit: -1, maxQueueWaitMs: 0 },
      ],
    });

    expect(cfg).toEqual({
      enabled: true,
      rules: [
        { model: 'v4/gpt-5.5', enabled: true, rpm: 12, queueLimit: 25, maxQueueWaitMs: 180_000 },
        { model: 'cx/gpt-5.5', enabled: false, rpm: 12, queueLimit: 100, maxQueueWaitMs: 300_000 },
      ],
    });
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('model_rate_limit_config') as { value: string };
    expect(JSON.parse(row.value)).toEqual(cfg);
  });

  it('falls back to defaults when stored config is invalid JSON', () => {
    const db = memDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('model_rate_limit_config', '{bad json');

    expect(getModelRateLimitConfig(db)).toEqual({ enabled: false, rules: [] });
  });

  it('caches reads and refreshes cache on save', () => {
    const db = memDb();
    saveModelRateLimitConfig(db, { enabled: true, rules: [{ model: 'v4/gpt-5.5', enabled: true, rpm: 12, queueLimit: 10, maxQueueWaitMs: 60_000 }] });
    const store = createModelRateLimitConfigStore(db);

    expect(store.get()).toEqual({ enabled: true, rules: [{ model: 'v4/gpt-5.5', enabled: true, rpm: 12, queueLimit: 10, maxQueueWaitMs: 60_000 }] });

    saveModelRateLimitConfig(db, { enabled: false, rules: [] });
    expect(store.get()).toEqual({ enabled: true, rules: [{ model: 'v4/gpt-5.5', enabled: true, rpm: 12, queueLimit: 10, maxQueueWaitMs: 60_000 }] });
    expect(store.save({ enabled: true, rules: [{ model: ' stable/model ', enabled: true, rpm: 30, queueLimit: 5, maxQueueWaitMs: 30_000 }] })).toEqual({ enabled: true, rules: [{ model: 'stable/model', enabled: true, rpm: 30, queueLimit: 5, maxQueueWaitMs: 30_000 }] });
    expect(store.get()).toEqual({ enabled: true, rules: [{ model: 'stable/model', enabled: true, rpm: 30, queueLimit: 5, maxQueueWaitMs: 30_000 }] });
  });
});
