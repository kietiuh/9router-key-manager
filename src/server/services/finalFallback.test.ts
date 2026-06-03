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
    expect(getFinalFallbackConfig(db)).toEqual({ enabled: false, model: '', models: [] });
  });

  it('saves enabled flag and trims model in app settings', () => {
    const db = memDb();
    const cfg = saveFinalFallbackConfig(db, { enabled: true, model: ' stable/model ' });

    expect(cfg).toEqual({ enabled: true, model: 'stable/model', models: ['stable/model'] });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_enabled')).toEqual({ value: 'true' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_model')).toEqual({ value: 'stable/model' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_models_json')).toEqual({ value: '["stable/model"]' });
  });

  it('saves ordered fallback models and keeps legacy model as the first entry', () => {
    const db = memDb();
    const cfg = saveFinalFallbackConfig(db, { enabled: true, model: ' stable/a ', models: ['stable/a', ' stable/b ', 'stable/a'] });

    expect(cfg).toEqual({ enabled: true, model: 'stable/a', models: ['stable/a', 'stable/b'] });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_model')).toEqual({ value: 'stable/a' });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('final_fallback_models_json')).toEqual({ value: '["stable/a","stable/b"]' });
  });

  it('reads legacy fallback model when models json is absent', () => {
    const db = memDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('final_fallback_enabled', 'true');
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('final_fallback_model', 'legacy/model');

    expect(getFinalFallbackConfig(db)).toEqual({ enabled: true, model: 'legacy/model', models: ['legacy/model'] });
  });

  it('uses models json as source of truth when it is present', () => {
    const db = memDb();
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('final_fallback_enabled', 'true');
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('final_fallback_model', 'legacy/model');
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('final_fallback_models_json', '[]');

    expect(getFinalFallbackConfig(db)).toEqual({ enabled: true, model: '', models: [] });
  });

  it('keeps the fallback model while disabled', () => {
    const db = memDb();
    expect(saveFinalFallbackConfig(db, { enabled: false, model: 'stable/model' })).toEqual({ enabled: false, model: 'stable/model', models: ['stable/model'] });
  });

  it('caches reads and refreshes cache on save', () => {
    const db = memDb();
    saveFinalFallbackConfig(db, { enabled: true, model: 'stable/model' });
    const store = createFinalFallbackStore(db);

    expect(store.get()).toEqual({ enabled: true, model: 'stable/model', models: ['stable/model'] });

    saveFinalFallbackConfig(db, { enabled: false, model: 'db-changed' });
    expect(store.get()).toEqual({ enabled: true, model: 'stable/model', models: ['stable/model'] });
    expect(store.save({ enabled: false, model: ' cache/model ' })).toEqual({ enabled: false, model: 'cache/model', models: ['cache/model'] });
    expect(store.get()).toEqual({ enabled: false, model: 'cache/model', models: ['cache/model'] });
  });
});
