import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { createClientRateLimitConfigStore, getClientRateLimitConfig, saveClientRateLimitConfig } from './clientRateLimitConfig.js';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('client rate limit config', () => {
  it('defaults enabled with 30 RPM and 5 concurrent requests per API key', () => {
    const db = memDb();

    expect(getClientRateLimitConfig(db)).toEqual({ enabled: true, rpm: 30, concurrency: 5 });
  });

  it('saves normalized config in app settings', () => {
    const db = memDb();
    const cfg = saveClientRateLimitConfig(db, {
      enabled: true,
      rpm: 42.8,
      concurrency: 3.2,
    });

    expect(cfg).toEqual({ enabled: true, rpm: 42, concurrency: 3 });
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('client_rate_limit_config') as { value: string };
    expect(JSON.parse(row.value)).toEqual(cfg);
  });

  it('falls back to default numbers when stored config is invalid JSON', () => {
    const db = memDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('client_rate_limit_config', '{bad json');

    expect(getClientRateLimitConfig(db)).toEqual({ enabled: true, rpm: 30, concurrency: 5 });
  });

  it('caches reads and refreshes cache on save', () => {
    const db = memDb();
    saveClientRateLimitConfig(db, { enabled: true, rpm: 20, concurrency: 4 });
    const store = createClientRateLimitConfigStore(db);

    expect(store.get()).toEqual({ enabled: true, rpm: 20, concurrency: 4 });

    saveClientRateLimitConfig(db, { enabled: false, rpm: 10, concurrency: 2 });
    expect(store.get()).toEqual({ enabled: true, rpm: 20, concurrency: 4 });
    expect(store.save({ enabled: false, rpm: 8, concurrency: 1 })).toEqual({ enabled: false, rpm: 8, concurrency: 1 });
    expect(store.get()).toEqual({ enabled: false, rpm: 8, concurrency: 1 });
  });
});
