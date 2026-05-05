import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStateDir, openDb } from './index.js';

let tmpDir: string;
let oldStateDir: string | undefined;
let oldDb: string | undefined;

describe('db index', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-db-'));
    oldStateDir = process.env.KEY_MANAGER_STATE_DIR;
    oldDb = process.env.KEY_MANAGER_DB;
    delete process.env.KEY_MANAGER_DB;
  });

  afterEach(() => {
    if (oldStateDir === undefined) delete process.env.KEY_MANAGER_STATE_DIR;
    else process.env.KEY_MANAGER_STATE_DIR = oldStateDir;
    if (oldDb === undefined) delete process.env.KEY_MANAGER_DB;
    else process.env.KEY_MANAGER_DB = oldDb;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses KEY_MANAGER_STATE_DIR for default state dir', () => {
    process.env.KEY_MANAGER_STATE_DIR = tmpDir;
    expect(defaultStateDir()).toBe(tmpDir);
  });

  it('opens a custom db path, creates parent dirs, and migrates schema', () => {
    const dbPath = path.join(tmpDir, 'nested', 'manager.sqlite');
    const db = openDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'key_policies'").get()).toEqual({ name: 'key_policies' });
    db.close();
  });

  it('uses KEY_MANAGER_DB when no explicit path is passed', () => {
    const dbPath = path.join(tmpDir, 'env.sqlite');
    process.env.KEY_MANAGER_DB = dbPath;
    const db = openDb();
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
  });
});
