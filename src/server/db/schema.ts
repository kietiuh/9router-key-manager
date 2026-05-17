import Database from 'better-sqlite3';

export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_policies (
      key_id TEXT PRIMARY KEY,
      name TEXT,
      window_start TEXT NOT NULL,
      window_end TEXT,
      token_limit INTEGER,
      reset_policy TEXT NOT NULL DEFAULT 'manual',
      expires_at TEXT,
      action_on_limit TEXT NOT NULL DEFAULT 'alert',
      notes TEXT,
      usage_multiplier REAL NOT NULL DEFAULT 1.0,
      usage_multiplier_effective_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_multiplier_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      multiplier REAL NOT NULL,
      effective_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_multiplier_events_key_time ON usage_multiplier_events (key_id, effective_at);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS alert_state (
      key_id TEXT NOT NULL,
      action TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key_id, action, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS auto_disabled_keys (
      key_id TEXT PRIMARY KEY,
      disabled_for_window_start TEXT NOT NULL,
      disabled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signature TEXT NOT NULL UNIQUE,
      api_key TEXT,
      model TEXT,
      provider TEXT,
      connection_id TEXT,
      timestamp TEXT NOT NULL,
      cost REAL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      reasoning_tokens INTEGER,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_key_time ON usage_events (api_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events (timestamp);
    CREATE TABLE IF NOT EXISTS image_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT,
      api_key TEXT,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      size TEXT,
      prompt_preview TEXT,
      prompt_hash TEXT,
      input_file TEXT,
      output_file TEXT,
      drive_path TEXT,
      status TEXT NOT NULL,
      error TEXT,
      image_count INTEGER NOT NULL DEFAULT 1,
      bytes INTEGER,
      estimated_prompt_tokens INTEGER,
      estimated_completion_tokens INTEGER,
      estimated_total_tokens INTEGER,
      usage_event_signature TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS model_rewrite_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS model_rewrite_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      from_model TEXT NOT NULL,
      to_model TEXT NOT NULL,
      to_models_json TEXT,
      sticky_count INTEGER NOT NULL DEFAULT 1,
      sticky_index INTEGER NOT NULL DEFAULT 0,
      sticky_used INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_model_rewrite_rules_from ON model_rewrite_rules (from_model);
  `);
  const cols = db.prepare("PRAGMA table_info(key_policies)").all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('usage_multiplier')) db.exec('ALTER TABLE key_policies ADD COLUMN usage_multiplier REAL NOT NULL DEFAULT 1.0');
  if (!names.has('usage_multiplier_effective_at')) db.exec('ALTER TABLE key_policies ADD COLUMN usage_multiplier_effective_at TEXT');
  const imageCols = db.prepare("PRAGMA table_info(image_usage_events)").all() as Array<{ name: string }>;
  const imageNames = new Set(imageCols.map(c => c.name));
  if (!imageNames.has('key_id')) db.exec('ALTER TABLE image_usage_events ADD COLUMN key_id TEXT');
  if (!imageNames.has('api_key')) db.exec('ALTER TABLE image_usage_events ADD COLUMN api_key TEXT');
  if (!imageNames.has('estimated_prompt_tokens')) db.exec('ALTER TABLE image_usage_events ADD COLUMN estimated_prompt_tokens INTEGER');
  if (!imageNames.has('estimated_completion_tokens')) db.exec('ALTER TABLE image_usage_events ADD COLUMN estimated_completion_tokens INTEGER');
  if (!imageNames.has('estimated_total_tokens')) db.exec('ALTER TABLE image_usage_events ADD COLUMN estimated_total_tokens INTEGER');
  if (!imageNames.has('usage_event_signature')) db.exec('ALTER TABLE image_usage_events ADD COLUMN usage_event_signature TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_usage_events_key_time ON image_usage_events (key_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_image_usage_events_signature ON image_usage_events (usage_event_signature);
  `);
  const rewriteCols = db.prepare("PRAGMA table_info(model_rewrite_rules)").all() as Array<{ name: string }>;
  const rewriteNames = new Set(rewriteCols.map(c => c.name));
  if (!rewriteNames.has('group_id')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN group_id INTEGER');
  if (!rewriteNames.has('sort_order')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  if (!rewriteNames.has('to_models_json')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN to_models_json TEXT');
  if (!rewriteNames.has('sticky_count')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN sticky_count INTEGER NOT NULL DEFAULT 1');
  if (!rewriteNames.has('sticky_index')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN sticky_index INTEGER NOT NULL DEFAULT 0');
  if (!rewriteNames.has('sticky_used')) db.exec('ALTER TABLE model_rewrite_rules ADD COLUMN sticky_used INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_rewrite_groups_order ON model_rewrite_groups (sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_model_rewrite_rules_group_order ON model_rewrite_rules (group_id, sort_order, id);
  `);
  const orphanRules = db.prepare('SELECT COUNT(*) count FROM model_rewrite_rules WHERE group_id IS NULL').get() as { count: number };
  if (Number(orphanRules.count) > 0) {
    db.prepare('INSERT INTO model_rewrite_groups (name, enabled, sort_order) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM model_rewrite_groups WHERE name = ?)').run('Default', 1, 0, 'Default');
    const defaultGroup = db.prepare('SELECT id FROM model_rewrite_groups WHERE name = ? ORDER BY id ASC LIMIT 1').get('Default') as { id: number };
    db.prepare('UPDATE model_rewrite_rules SET group_id = ?, sort_order = id WHERE group_id IS NULL').run(defaultGroup.id);
  }
}
