import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dbJsonPath } from '../parsers/paths.js';

export type StorageToggleResult = {
  storage: 'sqlite' | 'json';
  dbPath: string;
  found: boolean;
  changed: boolean;
  isActive: boolean;
};

export type ToggleResult = {
  changed: boolean;
  dbPath: string;
  isActive: boolean;
  primary: 'sqlite' | 'json';
  results: StorageToggleResult[];
};

function sqlitePath(baseDir?: string): string {
  return path.join(baseDir ?? process.env.NINE_ROUTER_DIR ?? path.join(process.env.HOME ?? '/root', '.9router'), 'db', 'data.sqlite');
}

function hasSqliteApiKeys(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'apiKeys'").get();
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function toggleSqliteApiKey(keyId: string, isActive: boolean, baseDir: string | undefined, now: Date): StorageToggleResult | null {
  const target = sqlitePath(baseDir);
  if (!hasSqliteApiKeys(target)) return null;
  const db = new Database(target, { fileMustExist: true });
  try {
    const row = db.prepare('SELECT id, isActive FROM apiKeys WHERE id = ?').get(keyId) as { id: string; isActive: number } | undefined;
    if (!row) return { storage: 'sqlite', dbPath: target, found: false, changed: false, isActive };
    const current = Number(row.isActive) !== 0;
    if (current === isActive) return { storage: 'sqlite', dbPath: target, found: true, changed: false, isActive };
    db.prepare('UPDATE apiKeys SET isActive = ? WHERE id = ?').run(isActive ? 1 : 0, keyId);
    const after = db.prepare('SELECT isActive FROM apiKeys WHERE id = ?').get(keyId) as { isActive: number } | undefined;
    if (!after || (Number(after.isActive) !== 0) !== isActive) throw new Error(`Failed to verify SQLite apiKeys toggle for ${keyId}`);
    return { storage: 'sqlite', dbPath: target, found: true, changed: true, isActive };
  } finally {
    db.close();
  }
}

function toggleJsonApiKey(keyId: string, isActive: boolean, baseDir: string | undefined, now: Date): StorageToggleResult | null {
  const target = dbJsonPath(baseDir);
  if (!fs.existsSync(target)) return null;
  const original = fs.readFileSync(target, 'utf8');
  const parsed = JSON.parse(original);
  if (!Array.isArray(parsed.apiKeys)) throw new Error('Invalid 9router db.json: apiKeys missing');
  const key = parsed.apiKeys.find((k: any) => k.id === keyId);
  if (!key) return { storage: 'json', dbPath: target, found: false, changed: false, isActive };
  if (key.isActive === isActive) return { storage: 'json', dbPath: target, found: true, changed: false, isActive };
  key.isActive = isActive;
  key.updatedAt = now.toISOString();
  const next = JSON.stringify(parsed, null, 2) + '\n';
  JSON.parse(next);
  const tmp = path.join(path.dirname(target), `.db.json.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, target);
  JSON.parse(fs.readFileSync(target, 'utf8'));
  return { storage: 'json', dbPath: target, found: true, changed: true, isActive };
}

function atomicToggleApiKey(keyId: string, isActive: boolean, baseDir?: string, now = new Date()): ToggleResult {
  const sqlite = toggleSqliteApiKey(keyId, isActive, baseDir, now);
  const json = toggleJsonApiKey(keyId, isActive, baseDir, now);
  const results = [sqlite, json].filter(Boolean) as StorageToggleResult[];
  if (results.length === 0) throw new Error('No supported 9router storage found (expected db/data.sqlite apiKeys or db.json apiKeys)');
  const primary = sqlite ? 'sqlite' : 'json';
  if (!results.some(r => r.found)) throw new Error(`API key not found in 9router storage: ${keyId}`);
  const primaryResult = (sqlite ?? json)!;
  return {
    changed: results.some(r => r.changed),
    dbPath: primaryResult.dbPath,
    isActive,
    primary,
    results,
  };
}

export function atomicDisableApiKey(keyId: string, baseDir?: string, now = new Date()): ToggleResult {
  return atomicToggleApiKey(keyId, false, baseDir, now);
}

export function atomicEnableApiKey(keyId: string, baseDir?: string, now = new Date()): ToggleResult {
  return atomicToggleApiKey(keyId, true, baseDir, now);
}
