import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { migrate } from './schema.js';

export function defaultStateDir(): string {
  return process.env.KEY_MANAGER_STATE_DIR ?? path.join(os.homedir(), '.local/state/9router-key-manager');
}

export function openDb(dbPath = process.env.KEY_MANAGER_DB ?? path.join(defaultStateDir(), 'manager.sqlite')): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  migrate(db);
  return db;
}
