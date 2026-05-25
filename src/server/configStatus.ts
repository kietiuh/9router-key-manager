import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { ConfigStatus } from '../shared/types.js';
import { VN_TZ_LABEL } from './utils/time.js';
import { usageSourceStatus } from './parsers/reader.js';
import { dbJsonPath, default9routerDir, usageJsonPath } from './parsers/paths.js';

type BuildConfigStatusOptions = {
  nineRouterDir?: string;
  managerDbPath?: string;
  hardDisable?: boolean;
};

export function buildConfigStatus(options: BuildConfigStatusOptions = {}): ConfigStatus {
  const nineRouterDir = options.nineRouterDir ?? default9routerDir();
  const dbPath = dbJsonPath(nineRouterDir);
  const usagePath = usageJsonPath(nineRouterDir);
  const dbJsonExists = fs.existsSync(dbPath);
  const usageJsonExists = fs.existsSync(usagePath);
  const source = usageSourceStatus(nineRouterDir);
  const errors: string[] = [];

  const sqliteReady = source.dataSqliteExists && isReadable9routerSqlite(source.dataSqlitePath);
  if (source.dataSqliteExists && !sqliteReady) {
    errors.push(`9router SQLite exists but is not readable at ${source.dataSqlitePath}`);
  }

  if (!sqliteReady) {
    if (!dbJsonExists) errors.push(`Missing 9router db.json at ${dbPath}`);
    if (!usageJsonExists) errors.push(`Missing 9router usage.json at ${usagePath}`);
  }

  return {
    ok: errors.length === 0,
    nineRouterDir,
    dbJsonPath: dbPath,
    usageJsonPath: usagePath,
    dataSqlitePath: source.dataSqlitePath,
    usageSource: sqliteReady ? 'sqlite' : 'json',
    dbJsonExists,
    usageJsonExists,
    dataSqliteExists: source.dataSqliteExists,
    managerDbPath: options.managerDbPath ?? process.env.KEY_MANAGER_DB ?? '~/.local/state/9router-key-manager/manager.sqlite',
    hardDisable: options.hardDisable ?? process.env.HARD_DISABLE === 'true',
    timezone: VN_TZ_LABEL,
    errors,
  };
}

function isReadable9routerSqlite(sqlitePath: string): boolean {
  try {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const apiKeys = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'apiKeys'").get();
      const usageHistory = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usageHistory'").get();
      return !!apiKeys && !!usageHistory;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}
