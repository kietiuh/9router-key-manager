import type Database from 'better-sqlite3';

export type ModelRewriteRule = {
  id: number;
  groupId?: number | null;
  enabled: boolean;
  fromModel: string;
  toModel: string;
  toModels: string[];
  stickyCount: number;
  stickyIndex?: number;
  stickyUsed?: number;
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

export type RewriteTargetPlan = {
  ruleId: number;
  fromModel: string;
  targets: string[];
  selectedModel: string;
  rewritten: true;
};

const GLOBAL_KEY = 'model_rewrite_enabled';

function normalizeTargets(rule: { toModel?: string | null; toModels?: unknown }): string[] {
  const raw = Array.isArray(rule.toModels) && rule.toModels.length ? rule.toModels : [rule.toModel];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const item of raw) {
    const target = String(item ?? '').trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

function parseStoredTargets(raw: unknown, fallback: unknown): string[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const targets = normalizeTargets({ toModels: parsed, toModel: String(fallback ?? '') });
      if (targets.length) return targets;
    } catch {
      // Legacy rows fall back to to_model below.
    }
  }
  return normalizeTargets({ toModel: String(fallback ?? '') });
}

function normalizeStickyCount(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function normalizeStickyIndex(value: unknown, targetCount: number): number {
  if (targetCount <= 0) return 0;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return ((n % targetCount) + targetCount) % targetCount;
}

function normalizeStickyUsed(value: unknown, stickyCount: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, Math.max(0, stickyCount - 1));
}

function targetsForRule(rule: Pick<ModelRewriteRule, 'toModel' | 'toModels'>): string[] {
  return normalizeTargets({ toModel: rule.toModel, toModels: rule.toModels });
}

function rotateTargets(targets: string[], start: number): string[] {
  if (!targets.length) return [];
  return [...targets.slice(start), ...targets.slice(0, start)];
}

function rowToRule(row: any): ModelRewriteRule {
  const toModels = parseStoredTargets(row.to_models_json, row.to_model);
  const stickyCount = normalizeStickyCount(row.sticky_count);
  return {
    id: Number(row.id),
    groupId: row.group_id == null ? null : Number(row.group_id),
    enabled: Boolean(row.enabled),
    fromModel: row.from_model,
    toModel: toModels[0] ?? row.to_model,
    toModels,
    stickyCount,
    stickyIndex: normalizeStickyIndex(row.sticky_index, toModels.length),
    stickyUsed: normalizeStickyUsed(row.sticky_used, stickyCount),
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

type SaveRule = { id?: number; groupId?: number | null; enabled?: boolean; fromModel: string; toModel?: string | null; toModels?: string[]; stickyCount?: number; note?: string | null };
type SaveGroup = { id?: number; name?: string; enabled?: boolean; rules?: SaveRule[] };
type SaveConfig = { enabled: boolean; groups?: SaveGroup[]; rules?: SaveRule[] };

function cleanRules(rules: SaveRule[] | undefined) {
  return (rules ?? []).map((r) => {
    const toModels = normalizeTargets(r);
    return {
      id: r.id,
      enabled: r.enabled !== false,
      fromModel: String(r.fromModel ?? '').trim(),
      toModel: toModels[0] ?? '',
      toModels,
      stickyCount: normalizeStickyCount((r as any).stickyCount),
      note: r.note?.trim() || null,
    };
  }).filter(r => r.fromModel && r.toModels.length);
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
    const insertRule = db.prepare('INSERT INTO model_rewrite_rules (group_id, enabled, from_model, to_model, to_models_json, sticky_count, sticky_index, sticky_used, note, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    clean.forEach((g, groupIndex) => {
      const result = insertGroup.run(g.enabled ? 1 : 0, g.name, groupIndex);
      const groupId = Number(result.lastInsertRowid);
      g.rules.forEach((r, ruleIndex) => insertRule.run(groupId, r.enabled ? 1 : 0, r.fromModel, r.toModel, JSON.stringify(r.toModels), r.stickyCount, 0, 0, r.note, ruleIndex));
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
  const target = targetsForRule(rule)[0] ?? rule.toModel;
  return { model: target, rewritten: true, toModel: target };
}

export function selectModelRewriteTargets(db: Database.Database, model: unknown): RewriteTargetPlan | undefined {
  if (typeof model !== 'string') return undefined;
  return db.transaction((input: string) => {
    const cfg = getModelRewriteConfig(db);
    const rule = findModelRewriteRule(input, cfg);
    if (!rule) return undefined;
    const targets = targetsForRule(rule);
    if (!targets.length) return undefined;
    const stickyCount = normalizeStickyCount(rule.stickyCount);
    const stickyIndex = normalizeStickyIndex(rule.stickyIndex, targets.length);
    const stickyUsed = normalizeStickyUsed(rule.stickyUsed, stickyCount);
    const selectedModel = targets[stickyIndex];
    let nextIndex = stickyIndex;
    let nextUsed = stickyUsed + 1;
    if (nextUsed >= stickyCount) {
      nextIndex = (stickyIndex + 1) % targets.length;
      nextUsed = 0;
    }
    db.prepare('UPDATE model_rewrite_rules SET sticky_index = ?, sticky_used = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextIndex, nextUsed, rule.id);
    return {
      ruleId: rule.id,
      fromModel: input,
      targets: rotateTargets(targets, stickyIndex),
      selectedModel,
      rewritten: true as const,
    };
  })(model);
}

export function rollbackModelRewriteSelection(db: Database.Database, plan: RewriteTargetPlan): void {
  db.transaction(() => {
    const cfg = getModelRewriteConfig(db);
    const rule = cfg.rules?.find(r => r.id === plan.ruleId);
    if (!rule) return;
    const targets = targetsForRule(rule);
    if (!targets.length) return;
    const stickyCount = normalizeStickyCount(rule.stickyCount);
    const stickyIndex = normalizeStickyIndex(rule.stickyIndex, targets.length);
    const stickyUsed = normalizeStickyUsed(rule.stickyUsed, stickyCount);
    let previousIndex = stickyIndex;
    let previousUsed = stickyUsed - 1;
    if (previousUsed < 0) {
      previousIndex = (stickyIndex - 1 + targets.length) % targets.length;
      previousUsed = stickyCount - 1;
    }
    db.prepare('UPDATE model_rewrite_rules SET sticky_index = ?, sticky_used = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(previousIndex, previousUsed, plan.ruleId);
  })();
}
