import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { runWatcherOnce, startWatcher } from './watcher.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-watch-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [{ id: 'a', name: 'A', key: 'sk-a', isActive: true }] }, null, 2));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ history: [{ apiKey: 'sk-a', model: 'm', timestamp: '2026-01-02T00:00:00.000Z', tokens: { total_tokens: 101 } }] }, null, 2));
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO key_policies (key_id, name, window_start, token_limit, action_on_limit) VALUES (?, ?, ?, ?, ?)').run('a', 'A', '2026-01-01T00:00:00.000Z', 100, 'disable');
  return { dir, db };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runWatcherOnce', () => {
  it('can hard-disable a key that exceeds quota', () => {
    const { dir, db } = fixture();
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    expect(out.events).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(false);
    expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toMatchObject({ n: 1 });
  });

  it('auto-enables daily quota lockouts when a new day window starts', () => {
    const { dir, db } = fixture();
    db.prepare('UPDATE key_policies SET reset_policy = ?, window_start = ? WHERE key_id = ?').run('daily', '2026-01-01T00:00:00.000Z', 'a');
    db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)').run('a', '2026-01-01T00:00:00.000Z', 'quota');
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    parsed.apiKeys[0].isActive = false;
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(parsed));
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(true);
    expect(out.actions.some((a: any) => a.action === 'auto.enable')).toBe(true);
  });

  it('keeps disable as alert-only action when hardDisable is false', () => {
    const { dir, db } = fixture();
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: false });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(true);
    expect(out.actions).toMatchObject([{ action: 'disable' }]);
    expect(db.prepare('SELECT COUNT(*) n FROM auto_disabled_keys').get()).toEqual({ n: 0 });
  });

  it('suppresses repeated watcher actions for the same fingerprint', () => {
    const { dir, db } = fixture();
    expect(runWatcherOnce(db, { baseDir: dir, hardDisable: true }).actions).toHaveLength(1);
    expect(runWatcherOnce(db, { baseDir: dir, hardDisable: true }).actions).toHaveLength(0);
  });

  it('does not restore non-daily auto-disabled rows', () => {
    const { dir, db } = fixture();
    db.prepare('UPDATE key_policies SET reset_policy = ?, window_start = ? WHERE key_id = ?').run('manual', '2026-01-02T00:00:00.000Z', 'a');
    db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)').run('a', '2026-01-01T00:00:00.000Z', 'quota');
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    parsed.apiKeys[0].isActive = false;
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(parsed));
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    expect(out.actions.some((a: any) => a.action === 'auto.enable')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM auto_disabled_keys').get()).toEqual({ n: 1 });
  });

  it('starts an interval and logs tick errors', () => {
    const { db } = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const interval = startWatcher(db, 1000, { baseDir: path.join(os.tmpdir(), 'missing-dir') });
    clearInterval(interval);
    expect(console.error).toHaveBeenCalled();
  });
});
