import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiKeys, readUsageHistory, usageSourceStatus } from './reader.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-reader-'));
}

function writeJsonSources(dir: string) {
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    apiKeys: [{ id: 'json-key', name: 'JSON key', key: 'sk-json' }],
  }));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
    history: [{ apiKey: 'sk-json', model: 'json-model', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 9 } }],
  }));
}

function sqlitePath(dir: string) {
  const dbDir = path.join(dir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, 'data.sqlite');
}

describe('reader', () => {
  it('reads JSON keys and usage when SQLite is absent', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
      apiKeys: [{ id: 'a', name: 'Key A', key: 'sk-a' }],
    }));
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({}));

    expect(readApiKeys(dir)).toEqual([{ id: 'a', name: 'Key A', key: 'sk-a', isActive: true }]);
    expect(readUsageHistory(dir)).toEqual([]);
    expect(usageSourceStatus(dir)).toMatchObject({ usageSource: 'json', dataSqliteExists: false });
  });

  it('prefers SQLite sources and normalizes stored key and usage shapes', () => {
    const dir = tmpDir();
    writeJsonSources(dir);
    const db = new Database(sqlitePath(dir));
    db.exec(`
      CREATE TABLE apiKeys (
        id TEXT,
        name TEXT,
        key TEXT,
        machineId TEXT,
        isActive TEXT,
        createdAt TEXT
      );
      CREATE TABLE usageHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
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
      );
      INSERT INTO apiKeys (id, name, key, machineId, isActive, createdAt)
      VALUES ('sql-key', 'SQL key', 'sk-sql', 'machine-a', 'true', '2026-05-01T00:00:00.000Z');
      INSERT INTO usageHistory (timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
      VALUES (
        '2026-05-01T01:00:00.000Z',
        'openai',
        'cx/gpt-5.5',
        'conn-a',
        'sk-sql',
        '/v1/chat/completions',
        10,
        5,
        0.25,
        'ok',
        '{"total_tokens":15,"cache_read_input_tokens":"3","reasoning_tokens":"2"}',
        '{}'
      );
    `);
    db.close();

    expect(readApiKeys(dir)).toEqual([{
      id: 'sql-key',
      name: 'SQL key',
      key: 'sk-sql',
      machineId: 'machine-a',
      isActive: true,
      createdAt: '2026-05-01T00:00:00.000Z',
    }]);
    const usage = readUsageHistory(dir);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      apiKey: 'sk-sql',
      model: 'cx/gpt-5.5',
      timestamp: '2026-05-01T01:00:00.000Z',
      cost: 0.25,
      tokens: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cache_read_input_tokens: 3,
        reasoning_tokens: 2,
      },
    });
    expect((usage[0] as any).provider).toBe('openai');
    expect((usage[0] as any).connectionId).toBe('conn-a');
    expect((usage[0] as any).endpoint).toBe('/v1/chat/completions');
    expect(usageSourceStatus(dir)).toMatchObject({ usageSource: 'sqlite', dataSqliteExists: true });
  });

  it('falls back to JSON when SQLite exists but cannot satisfy the expected schema', () => {
    const dir = tmpDir();
    writeJsonSources(dir);
    const db = new Database(sqlitePath(dir));
    db.close();

    expect(readApiKeys(dir)).toEqual([{ id: 'json-key', name: 'JSON key', key: 'sk-json', isActive: true }]);
    expect(readUsageHistory(dir)).toEqual([
      { apiKey: 'sk-json', model: 'json-model', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 9 } },
    ]);
  });
});
