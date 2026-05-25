import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildConfigStatus } from './configStatus.js';

function tmp9routerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '9router-config-status-'));
}

function createSqliteSource(baseDir: string) {
  const dbDir = path.join(baseDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'data.sqlite'));
  try {
    db.exec(`
      CREATE TABLE apiKeys (
        id TEXT PRIMARY KEY,
        name TEXT,
        key TEXT NOT NULL,
        machineId TEXT,
        isActive INTEGER DEFAULT 1,
        createdAt TEXT
      );
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        apiKey TEXT,
        model TEXT,
        tokens TEXT
      );
    `);
  } finally {
    db.close();
  }
}

describe('config status', () => {
  it('treats sqlite storage as configured without legacy json files', () => {
    const baseDir = tmp9routerDir();
    createSqliteSource(baseDir);

    const status = buildConfigStatus({
      nineRouterDir: baseDir,
      managerDbPath: '/tmp/manager.sqlite',
      hardDisable: true,
    });

    expect(status.ok).toBe(true);
    expect(status.usageSource).toBe('sqlite');
    expect(status.dataSqliteExists).toBe(true);
    expect(status.dbJsonExists).toBe(false);
    expect(status.usageJsonExists).toBe(false);
    expect(status.errors).toEqual([]);
  });

  it('requires legacy json files only when sqlite storage is missing', () => {
    const baseDir = tmp9routerDir();

    const status = buildConfigStatus({
      nineRouterDir: baseDir,
      managerDbPath: '/tmp/manager.sqlite',
      hardDisable: false,
    });

    expect(status.ok).toBe(false);
    expect(status.usageSource).toBe('json');
    expect(status.dataSqliteExists).toBe(false);
    expect(status.errors).toEqual([
      `Missing 9router db.json at ${path.join(baseDir, 'db.json')}`,
      `Missing 9router usage.json at ${path.join(baseDir, 'usage.json')}`,
    ]);
  });
});
