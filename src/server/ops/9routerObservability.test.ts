import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_OBSERVABILITY_MITIGATION,
  applyObservabilityMitigation,
  buildMitigatedSettings,
} from './9routerObservability.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9r-observability-'));
  const dbPath = path.join(dir, 'data.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tokens TEXT
      );
      CREATE TABLE requestDetails (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO settings(id, data) VALUES(1, ?)').run(
      JSON.stringify({
        requireLogin: true,
        enableObservability: true,
        observabilityEnabled: true,
        observabilityMaxRecords: 1000,
        observabilityBatchSize: 20,
        observabilityFlushIntervalMs: 5000,
        observabilityMaxJsonSize: 1024,
      }),
    );
    db.prepare('INSERT INTO usageHistory(timestamp, tokens) VALUES(?, ?)').run(
      '2026-05-23T00:00:00.000Z',
      JSON.stringify({ total_tokens: 10 }),
    );
    db.prepare('INSERT INTO requestDetails(id, timestamp, data) VALUES(?, ?, ?)').run(
      'detail-1',
      '2026-05-23T00:01:00.000Z',
      JSON.stringify({ request: { body: 'large' } }),
    );
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function readSettings(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    return JSON.parse(row.data);
  } finally {
    db.close();
  }
}

describe('9router observability mitigation ops', () => {
  it('builds mitigated settings while preserving unrelated settings', () => {
    const settings = buildMitigatedSettings({
      requireLogin: true,
      enableObservability: true,
      observabilityEnabled: true,
      observabilityMaxRecords: 1000,
      observabilityBatchSize: 20,
      observabilityFlushIntervalMs: 5000,
      observabilityMaxJsonSize: 1024,
    });

    expect(settings).toMatchObject({
      requireLogin: true,
      enableObservability: false,
      observabilityEnabled: false,
      observabilityMaxRecords: 100,
      observabilityBatchSize: 20,
      observabilityFlushIntervalMs: 5000,
      observabilityMaxJsonSize: 5,
    });
  });

  it('dry-runs without writing settings or creating a backup', async () => {
    const { dir, dbPath } = tempDb();

    const result = await applyObservabilityMitigation({
      dbPath,
      backupDir: path.join(dir, 'backups'),
      dryRun: true,
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(readSettings(dbPath).enableObservability).toBe(true);
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('applies settings and creates an online SQLite backup without deleting history', async () => {
    const { dir, dbPath } = tempDb();

    const result = await applyObservabilityMitigation({
      dbPath,
      backupDir: path.join(dir, 'backups'),
      dryRun: false,
    });

    const settings = readSettings(dbPath);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(result.changed).toBe(true);
      expect(result.backupPath).toMatch(/data\.sqlite\.observability\.\d{8}T\d{6}Z\.bak$/);
      expect(fs.existsSync(result.backupPath as string)).toBe(true);
      expect(settings).toMatchObject(DEFAULT_OBSERVABILITY_MITIGATION);
      expect(settings.observabilityEnabled).toBe(false);
      expect(db.prepare('SELECT COUNT(*) as n FROM usageHistory').get()).toMatchObject({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) as n FROM requestDetails').get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});
