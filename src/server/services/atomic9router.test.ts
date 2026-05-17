import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicDisableApiKey, atomicEnableApiKey } from './atomic9router.js';

function tmp9router(options: { sqlite?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [
    { id: 'a', name: 'A', key: 'sk-a', isActive: true },
    { id: 'b', name: 'B', key: 'sk-b', isActive: true }
  ] }, null, 2));
  if (options.sqlite) {
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    const db = new Database(path.join(dir, 'db', 'data.sqlite'));
    db.exec('CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)');
    db.prepare('INSERT INTO apiKeys (id, key, name, isActive, createdAt) VALUES (?, ?, ?, ?, ?)').run('a', 'sk-a', 'A', 1, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO apiKeys (id, key, name, isActive, createdAt) VALUES (?, ?, ?, ?, ?)').run('b', 'sk-b', 'B', 1, '2026-01-01T00:00:00.000Z');
    db.close();
  }
  return dir;
}

function sqliteActive(dir: string, id: string) {
  const db = new Database(path.join(dir, 'db', 'data.sqlite'), { readonly: true });
  try { return Number((db.prepare('SELECT isActive FROM apiKeys WHERE id = ?').get(id) as any).isActive) !== 0; }
  finally { db.close(); }
}

describe('atomic 9router key toggle', () => {
  it('backs up db.json and disables only target key on legacy storage', () => {
    const dir = tmp9router();
    const res = atomicDisableApiKey('b', dir, new Date('2026-01-01T00:00:00.000Z'));
    expect(res.primary).toBe('json');
    expect(res.changed).toBe(true);
    expect(fs.existsSync(res.backupPath)).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys.find((k: any) => k.id === 'a').isActive).toBe(true);
    expect(after.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(false);
    const backup = JSON.parse(fs.readFileSync(res.backupPath, 'utf8'));
    expect(backup.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(true);
  });

  it('uses SQLite as primary and mirrors db.json on modern 9router storage', () => {
    const dir = tmp9router({ sqlite: true });
    const res = atomicDisableApiKey('b', dir, new Date('2026-01-01T00:00:00.000Z'));
    expect(res.primary).toBe('sqlite');
    expect(res.results.map(r => r.storage).sort()).toEqual(['json', 'sqlite']);
    expect(sqliteActive(dir, 'a')).toBe(true);
    expect(sqliteActive(dir, 'b')).toBe(false);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(false);
    expect(res.results.every(r => fs.existsSync(r.backupPath))).toBe(true);
  });

  it('re-enables keys in both SQLite and db.json', () => {
    const dir = tmp9router({ sqlite: true });
    atomicDisableApiKey('b', dir, new Date('2026-01-01T00:00:00.000Z'));
    const res = atomicEnableApiKey('b', dir, new Date('2026-01-01T00:01:00.000Z'));
    expect(res.primary).toBe('sqlite');
    expect(sqliteActive(dir, 'b')).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(true);
  });

  it('reports unchanged when the key is already in the requested state', () => {
    const dir = tmp9router({ sqlite: true });
    const res = atomicEnableApiKey('a', dir, new Date('2026-01-01T00:00:00.000Z'));

    expect(res.changed).toBe(false);
    expect(res.results).toEqual([
      expect.objectContaining({ storage: 'sqlite', found: true, changed: false, isActive: true }),
      expect.objectContaining({ storage: 'json', found: true, changed: false, isActive: true }),
    ]);
  });

  it('throws when the key or storage cannot be found', () => {
    const dir = tmp9router();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-empty-'));

    expect(() => atomicDisableApiKey('missing', dir, new Date('2026-01-01T00:00:00.000Z'))).toThrow('API key not found');
    expect(() => atomicDisableApiKey('a', emptyDir, new Date('2026-01-01T00:00:00.000Z'))).toThrow('No supported 9router storage found');
  });
});
