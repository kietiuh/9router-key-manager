import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from './schema.js';

function columnNames(db: Database.Database, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name);
}

describe('db schema migration', () => {
  it('creates the current schema on an empty database', () => {
    const db = new Database(':memory:');
    migrate(db);

    expect(columnNames(db, 'key_policies')).toEqual(expect.arrayContaining(['image_daily_limit', 'usage_multiplier', 'usage_multiplier_effective_at']));
    expect(columnNames(db, 'image_usage_events')).toEqual(expect.arrayContaining(['key_id', 'api_key', 'estimated_total_tokens', 'usage_event_signature', 'expires_at']));
    expect(columnNames(db, 'model_rewrite_rules')).toEqual(expect.arrayContaining(['group_id', 'sort_order', 'to_models_json', 'sticky_count', 'sticky_index', 'sticky_used']));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_model_rewrite_rules_group_order')).toBeTruthy();
    db.close();
  });

  it('upgrades old tables and moves orphan rewrite rules into the default group', () => {
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
      CREATE TABLE image_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        image_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE model_rewrite_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled INTEGER NOT NULL DEFAULT 1,
        from_model TEXT NOT NULL,
        to_model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO model_rewrite_rules (from_model, to_model) VALUES ('old', 'new');
    `);

    migrate(db);

    const group = db.prepare('SELECT id, name, enabled, sort_order FROM model_rewrite_groups WHERE name = ?').get('Default') as { id: number; name: string; enabled: number; sort_order: number };
    const rule = db.prepare('SELECT group_id, sort_order, sticky_count, sticky_index, sticky_used FROM model_rewrite_rules WHERE from_model = ?').get('old') as Record<string, number>;

    expect(columnNames(db, 'key_policies')).toEqual(expect.arrayContaining(['image_daily_limit', 'usage_multiplier', 'usage_multiplier_effective_at']));
    expect(columnNames(db, 'image_usage_events')).toEqual(expect.arrayContaining(['key_id', 'api_key', 'estimated_prompt_tokens', 'estimated_completion_tokens', 'estimated_total_tokens', 'usage_event_signature', 'expires_at']));
    expect(group).toMatchObject({ name: 'Default', enabled: 1, sort_order: 0 });
    expect(rule).toMatchObject({ group_id: group.id, sort_order: 1, sticky_count: 1, sticky_index: 0, sticky_used: 0 });
    db.close();
  });
});
