import type Database from 'better-sqlite3';

export type ModelRewriteRule = {
  id: number;
  groupId?: number | null;
  enabled: boolean;
  fromModel: string;
  toModel: string;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ModelRewriteGroup = {
  id: number;
  name: string;
  enabled: boolean;
  rules: ModelRewriteRule[];
  createdAt?: string;
  updatedAt?: string;
};

export type ModelRewriteConfig = {
  enabled: boolean;
  groups: ModelRewriteGroup[];
  rules?: ModelRewriteRule[];
};

const GLOBAL_KEY = 'model_rewrite_enabled';

function rowToRule(row: any): ModelRewriteRule {
  return {
    id: Number(row.id),
    groupId: row.group_id == null ? null : Number(row.group_id),
    enabled: Boolean(row.enabled),
    fromModel: row.from_model,
    toModel: row.to_model,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGroup(row: any): ModelRewriteGroup {
  return {
    id: Number(row.id),
    name: row.name,
    enabled: Boolean(row.enabled),
    rules: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getModelRewriteConfig(db: Database.Database): ModelRewriteConfig {
  const setting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(GLOBAL_KEY) as { value?: string } | undefined;
  const groups = (db.prepare('SELECT * FROM model_rewrite_groups ORDER BY sort_order ASC, id ASC').all() as any[]).map(rowToGroup);
  const byId = new Map(groups.map(g => [g.id, g]));
  const rows = db.prepare('SELECT * FROM model_rewrite_rules ORDER BY COALESCE(group_id, 0) ASC, sort_order ASC, id ASC').all() as any[];
  for (const row of rows) {
    const rule = rowToRule(row);
    const group = byId.get(rule.groupId ?? 0);
    if (group) group.rules.push(rule);
  }
  return { enabled: setting?.value === 'true', groups, rules: groups.flatMap(g => g.rules) };
}

type SaveRule = { id?: number; groupId?: number | null; enabled?: boolean; fromModel: string; toModel: string; note?: string | null };
type SaveGroup = { id?: number; name?: string; enabled?: boolean; rules?: SaveRule[] };
type SaveConfig = { enabled: boolean; groups?: SaveGroup[]; rules?: SaveRule[] };

function cleanRules(rules: SaveRule[] | undefined) {
  return (rules ?? []).map((r) => ({
    id: r.id,
    enabled: r.enabled !== false,
    fromModel: r.fromModel.trim(),
    toModel: r.toModel.trim(),
    note: r.note?.trim() || null,
  })).filter(r => r.fromModel && r.toModel);
}

function cleanGroups(cfg: SaveConfig) {
  if (cfg.groups) return cfg.groups.map((g, i) => ({
    id: g.id,
    name: g.name?.trim() || `Group ${i + 1}`,
    enabled: g.enabled !== false,
    rules: cleanRules(g.rules),
  }));
  const rules = cleanRules(cfg.rules);
  return rules.length ? [{ name: 'Default', enabled: true, rules }] : [];
}

export function saveModelRewriteConfig(db: Database.Database, cfg: SaveConfig): ModelRewriteConfig {
  const clean = cleanGroups(cfg);
  db.transaction(() => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(GLOBAL_KEY, cfg.enabled ? 'true' : 'false');
    db.prepare('DELETE FROM model_rewrite_rules').run();
    db.prepare('DELETE FROM model_rewrite_groups').run();
    const insertGroup = db.prepare('INSERT INTO model_rewrite_groups (enabled, name, sort_order) VALUES (?, ?, ?)');
    const insertRule = db.prepare('INSERT INTO model_rewrite_rules (group_id, enabled, from_model, to_model, note, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    clean.forEach((g, groupIndex) => {
      const result = insertGroup.run(g.enabled ? 1 : 0, g.name, groupIndex);
      const groupId = Number(result.lastInsertRowid);
      g.rules.forEach((r, ruleIndex) => insertRule.run(groupId, r.enabled ? 1 : 0, r.fromModel, r.toModel, r.note, ruleIndex));
    });
  })();
  return getModelRewriteConfig(db);
}

function orderedGroups(cfg: ModelRewriteConfig): ModelRewriteGroup[] {
  if (cfg.groups?.length) return cfg.groups;
  return cfg.rules ? [{ id: 0, name: 'Default', enabled: true, rules: cfg.rules }] : [];
}

export function findModelRewriteRule(model: unknown, cfg: ModelRewriteConfig): ModelRewriteRule | undefined {
  if (!cfg.enabled || typeof model !== 'string') return undefined;
  for (const group of orderedGroups(cfg)) {
    if (!group.enabled) continue;
    const rule = group.rules.find(r => r.enabled && r.fromModel === model);
    if (rule) return rule;
  }
  return undefined;
}

export function rewriteModel(model: unknown, cfg: ModelRewriteConfig): { model: unknown; rewritten: boolean; toModel?: string } {
  const rule = findModelRewriteRule(model, cfg);
  if (!rule) return { model, rewritten: false };
  return { model: rule.toModel, rewritten: true, toModel: rule.toModel };
}
