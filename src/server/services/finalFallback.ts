import Database from 'better-sqlite3';

export type FinalFallbackConfig = {
  enabled: boolean;
  model: string;
};

const ENABLED_KEY = 'final_fallback_enabled';
const MODEL_KEY = 'final_fallback_model';

function readSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? '';
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, value);
}

export function getFinalFallbackConfig(db: Database.Database): FinalFallbackConfig {
  return {
    enabled: readSetting(db, ENABLED_KEY) === 'true',
    model: readSetting(db, MODEL_KEY).trim(),
  };
}

export function saveFinalFallbackConfig(db: Database.Database, cfg: FinalFallbackConfig): FinalFallbackConfig {
  const model = String(cfg.model ?? '').trim();
  db.transaction(() => {
    writeSetting(db, ENABLED_KEY, cfg.enabled ? 'true' : 'false');
    writeSetting(db, MODEL_KEY, model);
  })();
  return getFinalFallbackConfig(db);
}
