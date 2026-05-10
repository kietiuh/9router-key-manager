import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { getModelRewriteConfig, rewriteModel, rollbackModelRewriteSelection, saveModelRewriteConfig, selectModelRewriteTargets } from './modelRewrite.js';

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

  it('does not expose or create rewrite rule notes', () => {
    const db = memDb();
    const columns = (db.prepare('PRAGMA table_info(model_rewrite_rules)').all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).not.toContain('note');

    const cfg = saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'Main', rules: [
        { fromModel: 'A', toModel: 'B', note: 'unused' } as any,
      ] },
    ] });
    expect(cfg.groups[0].rules[0]).not.toHaveProperty('note');
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
        { fromModel: '  A  ', toModel: '  B  ', note: ' x ' } as any,
        { fromModel: '', toModel: 'C' },
      ] },
    ] });
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.groups[0].name).toBe('Group A');
    expect(cfg.groups[0].rules).toHaveLength(1);
    expect(cfg.groups[0].rules[0].fromModel).toBe('A');
    expect(cfg.groups[0].rules[0].toModel).toBe('B');
    expect(cfg.groups[0].rules[0]).not.toHaveProperty('note');
  });

  it('normalizes multiple targets and sticky count when saving groups', () => {
    const db = memDb();
    const cfg = saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: '  Group A  ', rules: [
        { fromModel: '  A  ', toModel: ' legacy ', toModels: [' v1 ', '', 'v2', 'v1'], stickyCount: 2, note: ' x ' } as any,
      ] },
    ] });
    expect(cfg.groups[0].rules).toHaveLength(1);
    expect(cfg.groups[0].rules[0]).toMatchObject({
      fromModel: 'A',
      toModel: 'v1',
      toModels: ['v1', 'v2'],
      stickyCount: 2,
      stickyIndex: 0,
      stickyUsed: 0,
    });
    expect(cfg.groups[0].rules[0]).not.toHaveProperty('note');
  });

  it('falls back to legacy toModel when old rows do not have toModels JSON', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE model_rewrite_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE model_rewrite_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        from_model TEXT NOT NULL,
        to_model TEXT NOT NULL,
        note TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO app_settings (key, value) VALUES ('model_rewrite_enabled', 'true');
      INSERT INTO model_rewrite_groups (name, enabled, sort_order) VALUES ('Default', 1, 0);
      INSERT INTO model_rewrite_rules (group_id, enabled, from_model, to_model, note, sort_order) VALUES (1, 1, 'legacy', 'next', 'old', 0);
    `);
    migrate(db);
    const rule = getModelRewriteConfig(db).groups[0].rules[0];
    expect(rule.toModel).toBe('next');
    expect(rule.toModels).toEqual(['next']);
    expect(rule.stickyCount).toBe(1);
    expect(rule.stickyIndex).toBe(0);
    expect(rule.stickyUsed).toBe(0);
  });

  it('selects sticky targets and rotates after stickyCount requests', () => {
    const db = memDb();
    saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'Main', rules: [
        { fromModel: 'source', toModels: ['v1', 'v2', 'v3'], stickyCount: 2 },
      ] },
    ] });

    const plans = Array.from({ length: 7 }, () => selectModelRewriteTargets(db, 'source'));

    expect(plans.map(p => p?.selectedModel)).toEqual(['v1', 'v1', 'v2', 'v2', 'v3', 'v3', 'v1']);
    expect(plans[4]?.targets).toEqual(['v3', 'v1', 'v2']);
  });

  it('does not advance sticky state when global rewrite is disabled', () => {
    const db = memDb();
    saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'Main', rules: [
        { fromModel: 'source', toModels: ['v1', 'v2'], stickyCount: 1 },
      ] },
    ] });
    db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'model_rewrite_enabled'").run();

    expect(selectModelRewriteTargets(db, 'source')).toBeUndefined();
    db.prepare("UPDATE app_settings SET value = 'true' WHERE key = 'model_rewrite_enabled'").run();
    expect(selectModelRewriteTargets(db, 'source')?.selectedModel).toBe('v1');
  });

  it('rolls back a sticky selection when the request is rejected before upstream', () => {
    const db = memDb();
    saveModelRewriteConfig(db, { enabled: true, groups: [
      { name: 'Main', rules: [
        { fromModel: 'source', toModels: ['v1', 'v2'], stickyCount: 2 },
      ] },
    ] });

    const plan = selectModelRewriteTargets(db, 'source');
    expect(plan?.selectedModel).toBe('v1');
    expect(getModelRewriteConfig(db).groups[0].rules[0].stickyUsed).toBe(1);

    rollbackModelRewriteSelection(db, plan!);

    expect(getModelRewriteConfig(db).groups[0].rules[0].stickyUsed).toBe(0);
    expect(selectModelRewriteTargets(db, 'source')?.selectedModel).toBe('v1');
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
    expect(cfg.groups[0].rules[0].toModels).toEqual(['next']);
    expect(cfg.rules?.[0].fromModel).toBe('legacy');
  });
});
