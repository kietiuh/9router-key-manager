import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { createFinalFallbackStore, getFinalFallbackConfig, saveFinalFallbackConfig } from './finalFallback.js';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('final fallback config', () => {
  it('defaults disabled with no model', () => {
    const db = memDb();
    expect(getFinalFallbackConfig(db)).toEqual({ enabled: false, model: '' });
  });

  it('saves enabled flag and trims model in app settings', () => {
    const db = memDb();
    const cfg = saveFinalFallbackConfig(db, { enabled: true, model: ' stable/model ' });

    expect(cfg).toEqual({ enabled: true, model: 'stable/model' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_enabled')).toEqual({ value: 'true' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_model')).toEqual({ value: 'stable/model' });
  });

  it('keeps the fallback model while disabled', () => {
    const db = memDb();
    expect(saveFinalFallbackConfig(db, { enabled: false, model: 'stable/model' })).toEqual({ enabled: false, model: 'stable/model' });
  });

  it('caches reads and refreshes cache on save', () => {
    const db = memDb();
    saveFinalFallbackConfig(db, { enabled: true, model: 'stable/model' });
    const store = createFinalFallbackStore(db);

    expect(store.get()).toEqual({ enabled: true, model: 'stable/model' });

    saveFinalFallbackConfig(db, { enabled: false, model: 'db-changed' });
    expect(store.get()).toEqual({ enabled: true, model: 'stable/model' });
    expect(store.save({ enabled: false, model: ' cache/model ' })).toEqual({ enabled: false, model: 'cache/model' });
    expect(store.get()).toEqual({ enabled: false, model: 'cache/model' });
  });
});
