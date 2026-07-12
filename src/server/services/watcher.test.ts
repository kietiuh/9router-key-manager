import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { runWatcherOnce } from './watcher.js';
import { BotDatabase, migrateBotDatabase } from '../../bot/database.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-watch-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [{ id: 'a', name: 'A', key: 'sk-a', isActive: true }] }, null, 2));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ history: [{ apiKey: 'sk-a', model: 'm', timestamp: '2026-01-02T00:00:00.000Z', tokens: { total_tokens: 101 } }] }, null, 2));
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO key_policies (key_id, name, window_start, token_limit, action_on_limit) VALUES (?, ?, ?, ?, ?)').run('a', 'A', '2026-01-01T00:00:00.000Z', 100, 'disable');
  return { dir, db };
}

function writeUsageSqlite(baseDir: string, rows: Array<{ timestamp: string; apiKey: string; total: number }>) {
  const dbDir = path.join(baseDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const source = new Database(path.join(dbDir, 'data.sqlite'));
  try {
    source.exec(`
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        connectionId TEXT,
        apiKey TEXT,
        endpoint TEXT,
        promptTokens INTEGER,
        completionTokens INTEGER,
        cost REAL,
        status TEXT,
        tokens TEXT,
        meta TEXT
      )
    `);
    const insert = source.prepare('INSERT INTO usageHistory (timestamp, apiKey, model, tokens) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(row.timestamp, row.apiKey, 'm', JSON.stringify({ total_tokens: row.total }));
  } finally {
    source.close();
  }
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

  it('hard-disables a quota breach that was previously seen in dry-run mode', () => {
    const { dir, db } = fixture();
    db.prepare('UPDATE key_policies SET reset_policy = ? WHERE key_id = ?').run('daily', 'a');
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ history: [{ apiKey: 'sk-a', model: 'm', timestamp: new Date().toISOString(), tokens: { total_tokens: 101 } }] }, null, 2));
    const dryRun = runWatcherOnce(db, { baseDir: dir, hardDisable: false });
    expect(dryRun.events).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) as n FROM alert_state').get()).toMatchObject({ n: 1 });

    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(false);
    expect(out.actions.some((a: any) => a.action === 'disable')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) as n FROM auto_disabled_keys WHERE key_id = ?').get('a')).toMatchObject({ n: 1 });
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

  it('does not auto-enable an expired key after a daily quota window reset', () => {
    const { dir, db } = fixture();
    db.prepare('UPDATE key_policies SET reset_policy = ?, window_start = ?, expires_at = ? WHERE key_id = ?')
      .run('daily', '2026-01-01T00:00:00.000Z', '2026-01-01T12:00:00.000Z', 'a');
    db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)').run('a', '2026-01-01T00:00:00.000Z', 'quota');
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    parsed.apiKeys[0].isActive = false;
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(parsed));
    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys[0].isActive).toBe(false);
    expect(out.actions.some((a: any) => a.action === 'auto.enable')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) as n FROM auto_disabled_keys WHERE key_id = ?').get('a')).toMatchObject({ n: 1 });
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

  it('enqueues bot alert jobs from watcher-computed summaries', () => {
    const { dir, db } = fixture();
    migrateBotDatabase(db);
    const botDb = new BotDatabase(db, { defaultAlertThresholdPercent: 10 });
    botDb.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-a', 'sk-a');
    botDb.setAlertSettings(123, true, 10);

    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: false });

    expect(out.botAlertJobs).toBe(1);
    const jobs = botDb.pendingAlertJobs(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      telegramUserId: 123,
      category: 'token_empty',
      thresholdPercent: 10,
    });
  });

  it('imports watcher usage incrementally from the latest stored event', () => {
    const { dir, db } = fixture();
    fs.unlinkSync(path.join(dir, 'usage.json'));
    db.prepare('UPDATE key_policies SET token_limit = ? WHERE key_id = ?').run(1000, 'a');
    writeUsageSqlite(dir, [
      { apiKey: 'sk-a', timestamp: '2026-01-02T01:00:00.000Z', total: 10 },
      { apiKey: 'sk-a', timestamp: '2026-01-02T02:01:00.000Z', total: 30 },
    ]);
    db.prepare(`INSERT INTO usage_events (
      signature, api_key, model, timestamp, total_tokens, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'existing',
      'sk-a',
      'm',
      '2026-01-02T02:00:00.000Z',
      20,
      JSON.stringify({ apiKey: 'sk-a', model: 'm', timestamp: '2026-01-02T02:00:00.000Z', tokens: { total_tokens: 20 } })
    );

    const out = runWatcherOnce(db, { baseDir: dir, hardDisable: true });

    expect(db.prepare('SELECT COUNT(*) as n FROM usage_events').get()).toMatchObject({ n: 2 });
    expect(out.summaries[0].total).toBe(50);
  });
});
