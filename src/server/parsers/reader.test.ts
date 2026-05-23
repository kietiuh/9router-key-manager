import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { readUsageHistorySince } from './reader.js';

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
  });
});
