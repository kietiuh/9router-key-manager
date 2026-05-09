import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { getModelRewriteConfig, rewriteModel, saveModelRewriteConfig } from './modelRewrite.js';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('model rewrite config', () => {
  it('defaults off with no groups', () => {
    const db = memDb();
    expect(getModelRewriteConfig(db)).toEqual({ enabled: false, groups: [], rules: [] });
  });

  it('rewrites only when globally enabled, group enabled, and rule enabled', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'Main', enabled: true, rules: [
        { enabled: true, fromModel: 'v1/cx/gpt-5.5', toModel: 'cx/gpt-5.5' },
        { enabled: false, fromModel: 'off', toModel: 'on' },
      ] },
      { name: 'Disabled group', enabled: false, rules: [
        { enabled: true, fromModel: 'group-off', toModel: 'group-on' },
      ] },
    ] });
    expect(rewriteModel('v1/cx/gpt-5.5', cfg)).toEqual({ model: 'cx/gpt-5.5', rewritten: true, toModel: 'cx/gpt-5.5' });
    expect(rewriteModel('off', cfg).rewritten).toBe(false);
    expect(rewriteModel('group-off', cfg).rewritten).toBe(false);
    expect(rewriteModel('other', cfg).rewritten).toBe(false);
    expect(rewriteModel('v1/cx/gpt-5.5', { ...cfg, enabled: false }).rewritten).toBe(false);
  });

  it('uses the first matching enabled rule by group and rule order', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'A', enabled: false, rules: [{ fromModel: 'same', toModel: 'disabled-group' }] },
      { name: 'B', enabled: true, rules: [{ fromModel: 'same', toModel: 'b' }] },
      { name: 'C', enabled: true, rules: [{ fromModel: 'same', toModel: 'c' }] },
    ] });
    expect(rewriteModel('same', cfg)).toEqual({ model: 'b', rewritten: true, toModel: 'b' });
  });

  it('keeps legacy top-level rules usable when groups are absent or empty', () => {
    const cfg = { enabled: true, groups: [], rules: [{ id: 1, enabled: true, fromModel: 'legacy', toModel: 'next' }] };
    expect(rewriteModel('legacy', cfg)).toEqual({ model: 'next', rewritten: true, toModel: 'next' });
  });

  it('trims and drops empty rules in groups', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: '  Group A  ', rules: [
        { fromModel: '  A  ', toModel: '  B  ', note: ' x ' },
        { fromModel: '', toModel: 'C' },
      ] },
    ] });
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.groups[0].name).toBe('Group A');
    expect(cfg.groups[0].rules).toHaveLength(1);
    expect(cfg.groups[0].rules[0].fromModel).toBe('A');
    expect(cfg.groups[0].rules[0].toModel).toBe('B');
    expect(cfg.groups[0].rules[0].note).toBe('x');
  });

  it('migrates existing flat rules into the Default group', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE model_rewrite_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enabled INTEGER NOT NULL DEFAULT 1,
        from_model TEXT NOT NULL,
        to_model TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_settings (key, value) VALUES ('model_rewrite_enabled', 'true');
      INSERT INTO model_rewrite_rules (enabled, from_model, to_model, note) VALUES (1, 'legacy', 'next', 'old');
    `);
    migrate(db);
    const cfg = getModelRewriteConfig(db);
    expect(cfg.enabled).toBe(true);
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.groups[0].name).toBe('Default');
    expect(cfg.groups[0].rules[0].fromModel).toBe('legacy');
    expect(cfg.groups[0].rules[0].toModel).toBe('next');
    expect(cfg.rules?.[0].fromModel).toBe('legacy');
  });
});
