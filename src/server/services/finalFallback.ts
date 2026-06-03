import Database from 'better-sqlite3';
import { normalizeFinalFallbackConfig } from '../../shared/finalFallback.js';
import type { FinalFallbackConfig } from '../../shared/types.js';

export type { FinalFallbackConfig } from '../../shared/types.js';

const ENABLED_KEY = 'final_fallback_enabled';
const MODEL_KEY = 'final_fallback_model';
const MODELS_KEY = 'final_fallback_models_json';

function readSetting(db: Database.Database, key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? '';
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, value);
}

function parseModels(raw: string, fallback: string): string[] {
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(item => String(item ?? ''));
    } catch {
      // Invalid JSON falls back to the legacy single-model setting.
    }
  }
  return fallback ? [fallback] : [];
}

export function getFinalFallbackConfig(db: Database.Database): FinalFallbackConfig {
  const model = readSetting(db, MODEL_KEY).trim();
  const rawModels = readSetting(db, MODELS_KEY);
  const models = parseModels(rawModels, model);
  return normalizeFinalFallbackConfig({
    enabled: readSetting(db, ENABLED_KEY) === 'true',
    model: rawModels.trim() ? (models[0] ?? '') : model,
    models,
  });
}

export function saveFinalFallbackConfig(db: Database.Database, cfg: FinalFallbackConfig): FinalFallbackConfig {
  const next = normalizeFinalFallbackConfig(cfg);
  db.transaction(() => {
    writeSetting(db, ENABLED_KEY, next.enabled ? 'true' : 'false');
    writeSetting(db, MODEL_KEY, next.model);
    writeSetting(db, MODELS_KEY, JSON.stringify(next.models ?? []));
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
