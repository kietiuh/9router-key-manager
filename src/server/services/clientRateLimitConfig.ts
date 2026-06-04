import Database from 'better-sqlite3';
import type { ClientRateLimitConfig } from '../../shared/types.js';
import { defaultClientRateLimitConfig, normalizeClientRateLimitConfig } from './clientRateLimiter.js';

const SETTING_KEY = 'client_rate_limit_config';

export type ClientRateLimitConfigStore = {
  get: () => ClientRateLimitConfig;
  save: (cfg: ClientRateLimitConfig) => ClientRateLimitConfig;
  refresh: () => ClientRateLimitConfig;
};

export function getClientRateLimitConfig(db: Database.Database): ClientRateLimitConfig {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return defaultClientRateLimitConfig();
  try {
    return normalizeClientRateLimitConfig(JSON.parse(row.value));
  } catch {
    return defaultClientRateLimitConfig();
  }
}

export function saveClientRateLimitConfig(db: Database.Database, config: ClientRateLimitConfig): ClientRateLimitConfig {
  const next = normalizeClientRateLimitConfig(config);
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(SETTING_KEY, JSON.stringify(next));
  return next;
}

export function createClientRateLimitConfigStore(db: Database.Database): ClientRateLimitConfigStore {
  let cached = getClientRateLimitConfig(db);
  return {
    get: () => cached,
    save: (cfg) => {
      cached = saveClientRateLimitConfig(db, cfg);
      return cached;
    },
    refresh: () => {
      cached = getClientRateLimitConfig(db);
      return cached;
    },
  };
}
