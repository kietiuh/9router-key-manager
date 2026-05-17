import { describe, expect, it, vi } from 'vitest';
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

describe('runWatcherOnce', () => {
  it('can hard-disable a key that exceeds quota', () => {
    const { dir, db } = fixture();
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    expect(out.events).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(false);
    expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toMatchObject({ n: 1 });
  });

  it('can emit a disable action without mutating storage when hard disable is off', () => {
    const { dir, db } = fixture();
    const out = runWatcherOnce(db, { baseDir: dir });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));

    expect(out.actions).toMatchObject([{ action: 'disable', keyId: 'a' }]);
    expect(after.apiKeys[0].isActive).toBe(true);
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

  it('hard-disables based on historical multiplied billable total, not raw actual tokens', () => {
    const { dir, db } = fixture();
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ history: [{ apiKey: 'sk-a', model: 'm', timestamp: '2026-01-02T00:00:00.000Z', tokens: { total_tokens: 60 } }] }, null, 2));
    db.prepare('UPDATE key_policies SET token_limit = ?, usage_multiplier = ?, usage_multiplier_effective_at = ? WHERE key_id = ?').run(100, 1, '2026-01-02T01:00:00.000Z', 'a');
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('a', 2, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('a', 1, '2026-01-02T01:00:00.000Z');
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    expect(out.summaries[0].actualTotal).toBe(60);
    expect(out.summaries[0].total).toBe(120);
    expect(out.events).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(false);
  });

  it('logs watcher tick errors instead of throwing out of the interval loop', () => {
    const db = new Database(':memory:');
    migrate(db);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = startWatcher(db, 60_000, { baseDir: path.join(os.tmpdir(), 'missing-9router-dir') });

    clearInterval(handle);

    expect(spy).toHaveBeenCalledWith('[watcher]', expect.any(Error));
    spy.mockRestore();
    db.close();
  });
});
