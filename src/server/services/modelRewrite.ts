import type Database from 'better-sqlite3';

export type ModelRewriteRule = {
  id: number;
  enabled: boolean;
  fromModel: string;
  toModel: string;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ModelRewriteConfig = {
  enabled: boolean;
  rules: ModelRewriteRule[];
};

const GLOBAL_KEY = 'model_rewrite_enabled';

function rowToRule(row: any): ModelRewriteRule {
  return {
    id: Number(row.id),
    enabled: Boolean(row.enabled),
    fromModel: row.from_model,
    toModel: row.to_model,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getModelRewriteConfig(db: Database.Database): ModelRewriteConfig {
  const setting = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(GLOBAL_KEY) as { value?: string } | undefined;
  const rows = db.prepare('SELECT * FROM model_rewrite_rules ORDER BY id ASC').all() as any[];
  return { enabled: setting?.value === 'true', rules: rows.map(rowToRule) };
}

export function saveModelRewriteConfig(db: Database.Database, cfg: { enabled: boolean; rules: Array<{ id?: number; enabled?: boolean; fromModel: string; toModel: string; note?: string | null }> }): ModelRewriteConfig {
  const clean = cfg.rules.map((r) => ({
    id: r.id,
    enabled: r.enabled !== false,
    fromModel: r.fromModel.trim(),
    toModel: r.toModel.trim(),
    note: r.note?.trim() || null,
  })).filter(r => r.fromModel && r.toModel);

  db.transaction(() => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(GLOBAL_KEY, cfg.enabled ? 'true' : 'false');
    db.prepare('DELETE FROM model_rewrite_rules').run();
    const insert = db.prepare('INSERT INTO model_rewrite_rules (enabled, from_model, to_model, note) VALUES (?, ?, ?, ?)');
    for (const r of clean) insert.run(r.enabled ? 1 : 0, r.fromModel, r.toModel, r.note);
  })();
  return getModelRewriteConfig(db);
}

export function rewriteModel(model: unknown, cfg: ModelRewriteConfig): { model: unknown; rewritten: boolean; toModel?: string } {
  if (!cfg.enabled || typeof model !== 'string') return { model, rewritten: false };
  const rule = cfg.rules.find(r => r.enabled && r.fromModel === model);
  if (!rule) return { model, rewritten: false };
  return { model: rule.toModel, rewritten: true, toModel: rule.toModel };
}
