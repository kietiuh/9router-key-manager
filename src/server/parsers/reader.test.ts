import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { readApiKeys, readUsageHistory, usageSourceStatus } from './reader.js';

const tmpDirs: string[] = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-reader-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonSources(dir: string) {
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [{ id: 'json-key', name: 'JSON Key', key: 'sk-json' }] }));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ history: [{ apiKey: 'sk-json', model: 'json-model', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 7 } }] }));
}

function createSqlite(dir: string) {
  const sqliteDir = path.join(dir, 'db');
  fs.mkdirSync(sqliteDir, { recursive: true });
  const d = new Database(path.join(sqliteDir, 'data.sqlite'));
  d.exec(`
    CREATE TABLE apiKeys (
      id TEXT,
      name TEXT,
      key TEXT,
      machineId TEXT,
      isActive,
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
  `);
  return d;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reader json fallback', () => {
  it('reads keys and usage history from json files when sqlite is absent', () => {
    const dir = tmpDir();
    writeJsonSources(dir);

    expect(readApiKeys(dir)).toEqual([{ id: 'json-key', name: 'JSON Key', key: 'sk-json', isActive: true }]);
    expect(readUsageHistory(dir)).toEqual([{ apiKey: 'sk-json', model: 'json-model', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 7 } }]);
    expect(usageSourceStatus(dir)).toEqual({ usageSource: 'json', dataSqlitePath: path.join(dir, 'db', 'data.sqlite'), dataSqliteExists: false });
  });

  it('falls back to json when sqlite cannot be read', () => {
    const dir = tmpDir();
    writeJsonSources(dir);
    fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'db', 'data.sqlite'), 'not sqlite');

    expect(readApiKeys(dir).map(key => key.id)).toEqual(['json-key']);
    expect(readUsageHistory(dir).map(row => row.model)).toEqual(['json-model']);
    expect(usageSourceStatus(dir).usageSource).toBe('sqlite');
  });
});

describe('reader sqlite source', () => {
  it('prefers sqlite api keys and coerces row values', () => {
    const dir = tmpDir();
    writeJsonSources(dir);
    const d = createSqlite(dir);
    d.prepare('INSERT INTO apiKeys (id, name, key, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run('sqlite-b', 'Bravo', 'sk-b', null, 'true', '2026-05-02T00:00:00.000Z');
    d.prepare('INSERT INTO apiKeys (id, name, key, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run('sqlite-a', null, 'sk-a', 'machine-a', 0, null);
    d.close();

    const keys = readApiKeys(dir);
    expect(keys).toHaveLength(2);
    expect(keys.find(key => key.id === 'sqlite-a')).toEqual({ id: 'sqlite-a', name: 'sqlite-a', key: 'sk-a', machineId: 'machine-a', isActive: false });
    expect(keys.find(key => key.id === 'sqlite-b')).toEqual({ id: 'sqlite-b', name: 'Bravo', key: 'sk-b', isActive: true, createdAt: '2026-05-02T00:00:00.000Z' });
  });

  it('prefers sqlite usage history and normalizes token fields', () => {
    const dir = tmpDir();
    writeJsonSources(dir);
    const d = createSqlite(dir);
    d.prepare(`INSERT INTO usageHistory (timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '2026-05-01T00:00:00.000Z',
      'openai',
      'gpt',
      'conn',
      'sk-a',
      '/v1/chat/completions',
      3,
      4,
      0.25,
      'success',
      JSON.stringify({ total_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, reasoning_tokens: 5 }),
      '{}',
    );
    d.prepare(`INSERT INTO usageHistory (timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      '2026-05-01T01:00:00.000Z',
      null,
      'fallback',
      null,
      null,
      null,
      11,
      12,
      null,
      null,
      '{',
      null,
    );
    d.close();

    expect(readUsageHistory(dir)).toEqual([
      {
        apiKey: 'sk-a',
        model: 'gpt',
        timestamp: '2026-05-01T00:00:00.000Z',
        cost: 0.25,
        provider: 'openai',
        connectionId: 'conn',
        endpoint: '/v1/chat/completions',
        status: 'success',
        tokens: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 10,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
          reasoning_tokens: 5,
        },
      },
      {
        apiKey: undefined,
        model: 'fallback',
        timestamp: '2026-05-01T01:00:00.000Z',
        cost: undefined,
        provider: undefined,
        connectionId: undefined,
        endpoint: undefined,
        status: undefined,
        tokens: {
          prompt_tokens: 11,
          completion_tokens: 12,
          total_tokens: undefined,
          cache_read_input_tokens: undefined,
          cache_creation_input_tokens: undefined,
          reasoning_tokens: undefined,
        },
      },
    ]);
    expect(usageSourceStatus(dir)).toEqual({ usageSource: 'sqlite', dataSqlitePath: path.join(dir, 'db', 'data.sqlite'), dataSqliteExists: true });
  });
});
