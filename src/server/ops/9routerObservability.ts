import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

type SettingsJson = Record<string, unknown>;

export const DEFAULT_OBSERVABILITY_MITIGATION = {
  enableObservability: false,
  observabilityMaxRecords: 100,
  observabilityMaxJsonSize: 5,
} as const;

export type ObservabilityMitigationSettings = typeof DEFAULT_OBSERVABILITY_MITIGATION;

export interface ApplyObservabilityMitigationOptions {
  dbPath: string;
  dryRun?: boolean;
  desired?: ObservabilityMitigationSettings;
}

export interface ApplyObservabilityMitigationResult {
  dbPath: string;
  changed: boolean;
  current: SettingsJson;
  target: SettingsJson;
}

export function default9routerDbPath(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()) {
  if (env.NINE_ROUTER_DB) return env.NINE_ROUTER_DB;
  if (env.NINE_ROUTER_DIR) return path.join(env.NINE_ROUTER_DIR, 'db', 'data.sqlite');
  return path.join(homeDir, '.9router', 'db', 'data.sqlite');
}

export function buildMitigatedSettings(
  current: SettingsJson,
  desired: ObservabilityMitigationSettings = DEFAULT_OBSERVABILITY_MITIGATION,
): SettingsJson {
  const target: SettingsJson = {
    ...current,
    ...desired,
  };

  if (Object.prototype.hasOwnProperty.call(current, 'observabilityEnabled')) {
    target.observabilityEnabled = desired.enableObservability;
  }

  return target;
}

export async function applyObservabilityMitigation(
  options: ApplyObservabilityMitigationOptions,
): Promise<ApplyObservabilityMitigationResult> {
  const dbPath = path.resolve(options.dbPath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`9router SQLite DB not found: ${dbPath}`);
  }

  const db = new Database(dbPath);
  try {
    assertSettingsTableExists(db, dbPath);
    const current = readSettings(db);
    const target = buildMitigatedSettings(current, options.desired);
    const changed = JSON.stringify(current) !== JSON.stringify(target);

    if (!options.dryRun && changed) {
      db.prepare('INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
        JSON.stringify(target),
      );
    }

    return {
      dbPath,
      changed,
      current,
      target,
    };
  } finally {
    db.close();
  }
}

function readSettings(db: Database.Database): SettingsJson {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('9router settings row contains invalid JSON');
  }
}

function assertSettingsTableExists(db: Database.Database, dbPath: string) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get() as { name: string } | undefined;
  if (!row) {
    throw new Error(`9router settings table not found in ${dbPath}; start 9router once before applying this mitigation`);
  }
}
