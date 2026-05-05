import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readApiKeys, readUsageHistory } from './reader.js';

let tmpDir: string;

function writeJson(name: string, value: unknown) {
  fs.writeFileSync(path.join(tmpDir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('9router reader', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-reader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads api keys and defaults missing isActive to true', () => {
    writeJson('db.json', { apiKeys: [{ id: 'a', name: 'Key A', key: 'sk-a', machineId: 'm1' }], ignored: true });
    expect(readApiKeys(tmpDir)).toEqual([{ id: 'a', name: 'Key A', key: 'sk-a', machineId: 'm1', isActive: true }]);
  });

  it('defaults missing apiKeys to an empty list', () => {
    writeJson('db.json', { other: [] });
    expect(readApiKeys(tmpDir)).toEqual([]);
  });

  it('throws for malformed or invalid api key files', () => {
    writeJson('db.json', '{bad');
    expect(() => readApiKeys(tmpDir)).toThrow();

    writeJson('db.json', { apiKeys: [{ id: 'a', name: 'Key A', key: 123 }] });
    expect(() => readApiKeys(tmpDir)).toThrow();
  });

  it('reads usage history with optional token metadata', () => {
    const row = { apiKey: 'sk-a', model: 'm', timestamp: '2026-05-01T00:00:00.000Z', cost: 0.1, tokens: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cache_read_input_tokens: 4, reasoning_tokens: 5 }, extra: 'kept' };
    writeJson('usage.json', { history: [row] });
    expect(readUsageHistory(tmpDir)).toEqual([row]);
  });

  it('defaults missing usage history to an empty list', () => {
    writeJson('usage.json', { other: [] });
    expect(readUsageHistory(tmpDir)).toEqual([]);
  });

  it('throws for malformed usage files or rows without timestamps', () => {
    writeJson('usage.json', '{bad');
    expect(() => readUsageHistory(tmpDir)).toThrow();

    writeJson('usage.json', { history: [{ apiKey: 'sk-a' }] });
    expect(() => readUsageHistory(tmpDir)).toThrow();
  });
});
