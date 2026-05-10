import Database from 'better-sqlite3';
import { normalizeFinalFallbackConfig } from '../../shared/finalFallback.js';
import type { FinalFallbackConfig } from '../../shared/types.js';

export type { FinalFallbackConfig } from '../../shared/types.js';

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
  const next = normalizeFinalFallbackConfig(cfg);
  db.transaction(() => {
    writeSetting(db, ENABLED_KEY, next.enabled ? 'true' : 'false');
    writeSetting(db, MODEL_KEY, next.model);
  })();
  return getFinalFallbackConfig(db);
}

export type FinalFallbackStore = {
  get: () => FinalFallbackConfig;
  save: (cfg: FinalFallbackConfig) => FinalFallbackConfig;
  refresh: () => FinalFallbackConfig;
};

export function createFinalFallbackStore(db: Database.Database): FinalFallbackStore {
  let cached = getFinalFallbackConfig(db);
  return {
    get: () => cached,
    save: (cfg) => {
      cached = saveFinalFallbackConfig(db, cfg);
      return cached;
    },
    refresh: () => {
      cached = getFinalFallbackConfig(db);
      return cached;
    },
  };
}
