import Database from 'better-sqlite3';
import type { ModelRateLimitConfig } from '../../shared/types.js';
import { defaultModelRateLimitConfig, normalizeModelRateLimitConfig } from './modelRateLimiter.js';

const SETTING_KEY = 'model_rate_limit_config';

export type ModelRateLimitConfigStore = {
  get: () => ModelRateLimitConfig;
  save: (cfg: ModelRateLimitConfig) => ModelRateLimitConfig;
  refresh: () => ModelRateLimitConfig;
};

export function getModelRateLimitConfig(db: Database.Database): ModelRateLimitConfig {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return defaultModelRateLimitConfig();
  try {
    return normalizeModelRateLimitConfig(JSON.parse(row.value));
  } catch {
    return defaultModelRateLimitConfig();
  }
}

export function saveModelRateLimitConfig(db: Database.Database, config: ModelRateLimitConfig): ModelRateLimitConfig {
  const next = normalizeModelRateLimitConfig(config);
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(SETTING_KEY, JSON.stringify(next));
  return next;
}

export function createModelRateLimitConfigStore(db: Database.Database): ModelRateLimitConfigStore {
  let cached = getModelRateLimitConfig(db);
  return {
    get: () => cached,
    save: (cfg) => {
      cached = saveModelRateLimitConfig(db, cfg);
      return cached;
    },
    refresh: () => {
      cached = getModelRateLimitConfig(db);
      return cached;
    },
  };
}
