import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from './schema.js';

function tableNames(db: Database.Database) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(x => x.name);
}

function columnNames(db: Database.Database, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(x => x.name);
}

describe('migrate', () => {
  it('creates the current schema and remains idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    const onceTables = tableNames(db);
    migrate(db);
    expect(tableNames(db)).toEqual(onceTables);
    expect(onceTables).toEqual(['alert_state', 'app_settings', 'audit_log', 'auto_disabled_keys', 'image_usage_events', 'key_policies', 'model_rewrite_rules', 'usage_multiplier_events']);
    expect(columnNames(db, 'key_policies')).toEqual(['key_id', 'name', 'window_start', 'window_end', 'token_limit', 'reset_policy', 'expires_at', 'action_on_limit', 'notes', 'usage_multiplier', 'usage_multiplier_effective_at', 'created_at', 'updated_at']);
  });

  it('adds multiplier columns to legacy key_policies without losing rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE key_policies (
        key_id TEXT PRIMARY KEY,
        name TEXT,
        window_start TEXT NOT NULL,
        window_end TEXT,
        token_limit INTEGER,
        reset_policy TEXT NOT NULL DEFAULT 'manual',
        expires_at TEXT,
        action_on_limit TEXT NOT NULL DEFAULT 'alert',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO key_policies (key_id, name, window_start) VALUES ('a', 'Key A', '2026-05-01T00:00:00.000Z');
    `);

    migrate(db);
    expect(columnNames(db, 'key_policies')).toContain('usage_multiplier');
    expect(columnNames(db, 'key_policies')).toContain('usage_multiplier_effective_at');
    expect(db.prepare('SELECT key_id, name, usage_multiplier, usage_multiplier_effective_at FROM key_policies').get()).toEqual({ key_id: 'a', name: 'Key A', usage_multiplier: 1, usage_multiplier_effective_at: null });
  });

  it('creates model rewrite and multiplier indexes', () => {
    const db = new Database(':memory:');
    migrate(db);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{ name: string }>).map(x => x.name);
    expect(indexes).toContain('idx_model_rewrite_rules_from');
    expect(indexes).toContain('idx_usage_multiplier_events_key_time');
  });
});
