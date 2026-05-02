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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
    CREATE TABLE IF NOT EXISTS image_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
