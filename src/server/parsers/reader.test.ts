import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { parseTokens, readUsageHistorySince } from './reader.js';

function tmp9routerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '9router-reader-'));
}

describe('reader usage history', () => {
  it('reads incremental usage rows from sqlite', () => {
    const baseDir = tmp9routerDir();
    const dbDir = path.join(baseDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'data.sqlite'));
    try {
      db.exec(`
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
      const insert = db.prepare('INSERT INTO usageHistory (timestamp, apiKey, model, promptTokens, completionTokens, tokens) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('2026-05-08T00:00:00.000Z', 'sk-a', 'm', 1, 2, null);
      insert.run('2026-05-08T01:00:00.000Z', 'sk-a', 'm', 3, 4, JSON.stringify({ total_tokens: 20 }));
    } finally {
      db.close();
    }

    const rows = readUsageHistorySince('2026-05-08T00:30:00.000Z', baseDir);

    expect(rows.map(r => r.timestamp)).toEqual(['2026-05-08T01:00:00.000Z']);
    expect(rows[0].tokens?.total_tokens).toBe(20);
  });

  it('filters json fallback usage rows by timestamp', () => {
    const baseDir = tmp9routerDir();
    fs.writeFileSync(path.join(baseDir, 'usage.json'), JSON.stringify({
      history: [
        { apiKey: 'sk-a', timestamp: '2026-05-08T00:00:00.000Z', tokens: { total_tokens: 10 } },
        { apiKey: 'sk-a', timestamp: '2026-05-08T01:00:00.000Z', tokens: { total_tokens: 20 } },
      ],
    }));

    const rows = readUsageHistorySince('2026-05-08T00:30:00.000Z', baseDir);

    expect(rows.map(r => r.timestamp)).toEqual(['2026-05-08T01:00:00.000Z']);
    expect(rows[0].tokens?.total_tokens).toBe(20);
  });

  it('maps cached_tokens (9router) to cache_read_input_tokens', () => {
    const tokens = parseTokens(JSON.stringify({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 42 }));
    expect(tokens?.cache_read_input_tokens).toBe(42);
    expect(tokens?.prompt_tokens).toBe(100);
    expect(tokens?.completion_tokens).toBe(5);
  });

  it('falls back to cache_read_input_tokens when cached_tokens is absent', () => {
    const tokens = parseTokens(JSON.stringify({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 17 }));
    expect(tokens?.cache_read_input_tokens).toBe(17);
  });

  it('prefers cache_read_input_tokens when both keys are present', () => {
    // cache_read_input_tokens is the canonical Anthropic name; if it is set,
    // we trust it over the 9router alias to avoid double-counting.
    const tokens = parseTokens(JSON.stringify({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 7, cached_tokens: 99 }));
    expect(tokens?.cache_read_input_tokens).toBe(7);
  });

  it('returns undefined when neither cache field is present', () => {
    const tokens = parseTokens(JSON.stringify({ prompt_tokens: 100, completion_tokens: 5 }));
    expect(tokens?.cache_read_input_tokens).toBeUndefined();
  });

  it('reads tokens JSON column and maps cached_tokens from sqlite', () => {
    const baseDir = tmp9routerDir();
    const dbDir = path.join(baseDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'data.sqlite'));
    try {
      db.exec(`
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
      db.prepare('INSERT INTO usageHistory (timestamp, apiKey, model, promptTokens, completionTokens, tokens) VALUES (?, ?, ?, ?, ?, ?)')
        .run('2026-05-08T00:00:00.000Z', 'sk-a', 'm', 100, 5, JSON.stringify({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 7 }));
    } finally { db.close(); }

    const rows = readUsageHistorySince(undefined, baseDir);

    expect(rows[0].tokens?.cache_read_input_tokens).toBe(7);
  });
});
