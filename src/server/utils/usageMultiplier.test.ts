import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { applyUsageMultiplierToUsage, createUsageScalingSseTransform, resolveMultiplierForKey } from './usageMultiplier.js';

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE key_policies (
      key_id TEXT PRIMARY KEY,
      usage_multiplier REAL NOT NULL DEFAULT 1.0,
      usage_multiplier_effective_at TEXT
    );
    CREATE TABLE usage_multiplier_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      multiplier REAL NOT NULL,
      effective_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('applyUsageMultiplierToUsage', () => {
  it('scales OpenAI flat fields', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_read_input_tokens: 80 };
    applyUsageMultiplierToUsage(usage, 2);
    expect(usage).toEqual({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, cache_read_input_tokens: 160 });
  });

  it('scales OpenAI nested token details', () => {
    const usage = {
      prompt_tokens_details: { cached_tokens: 80, audio_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 40 },
    } as any;
    applyUsageMultiplierToUsage(usage, 1.5);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(120);
    expect(usage.prompt_tokens_details.audio_tokens).toBe(5); // not in our list
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(60);
  });

  it('scales Anthropic flat fields (input_tokens, output_tokens)', () => {
    const usage = { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 };
    applyUsageMultiplierToUsage(usage, 0.5);
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25, cache_creation_input_tokens: 13 });
  });

  it('rounds with Math.round (e.g. 1.5 * 7 = 11)', () => {
    const usage = { prompt_tokens: 7 };
    applyUsageMultiplierToUsage(usage, 1.5);
    expect(usage.prompt_tokens).toBe(11);
  });

  it('produces the same result for equal inputs (regardless of object identity)', () => {
    // The helper mutates in place, so calling it once on each of two fresh
    // objects with the same shape and factor must yield the same outcome.
    const a = { prompt_tokens: 100 };
    const b = { prompt_tokens: 100 };
    applyUsageMultiplierToUsage(a, 2);
    applyUsageMultiplierToUsage(b, 2);
    expect(a).toEqual(b);
  });

  it('skips missing fields (no-op)', () => {
    const usage = { prompt_tokens: 100 } as any;
    applyUsageMultiplierToUsage(usage, 2);
    expect(usage).toEqual({ prompt_tokens: 200 });
  });

  it('skips non-numeric field values', () => {
    const usage: any = { prompt_tokens: 'abc', completion_tokens: null, total_tokens: undefined };
    applyUsageMultiplierToUsage(usage, 2);
    expect(usage).toEqual({ prompt_tokens: 'abc', completion_tokens: null, total_tokens: undefined });
  });

  it('skips non-finite numeric values (NaN, Infinity)', () => {
    const usage: any = { prompt_tokens: Number.NaN, completion_tokens: Number.POSITIVE_INFINITY };
    applyUsageMultiplierToUsage(usage, 2);
    expect(usage.prompt_tokens).toBeNaN();
    expect(usage.completion_tokens).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns non-object input unchanged', () => {
    expect(applyUsageMultiplierToUsage(null, 2)).toBeNull();
    expect(applyUsageMultiplierToUsage(undefined, 2)).toBeUndefined();
    expect(applyUsageMultiplierToUsage('not-an-object', 2)).toBe('not-an-object');
    expect(applyUsageMultiplierToUsage(42, 2)).toBe(42);
  });

  it('returns the same object reference', () => {
    const usage = { prompt_tokens: 10 };
    expect(applyUsageMultiplierToUsage(usage, 2)).toBe(usage);
  });

  it('does not create nested objects that did not exist', () => {
    const usage: any = {};
    applyUsageMultiplierToUsage(usage, 2);
    expect(usage.prompt_tokens_details).toBeUndefined();
    expect(usage.completion_tokens_details).toBeUndefined();
  });
});

describe('resolveMultiplierForKey', () => {
  it('returns factor 1 when key has no policy', () => {
    const db = setupDb();
    expect(resolveMultiplierForKey(db, 'unknown-key').factor).toBe(1);
  });

  it('returns factor 1 when policy has no effective_at and no events', () => {
    const db = setupDb();
    db.prepare('INSERT INTO key_policies (key_id, usage_multiplier) VALUES (?, ?)').run('k1', 1.5);
    expect(resolveMultiplierForKey(db, 'k1').factor).toBe(1);
  });

  it('uses policy usage_multiplier as a single-event fallback', () => {
    const db = setupDb();
    db.prepare('INSERT INTO key_policies (key_id, usage_multiplier, usage_multiplier_effective_at) VALUES (?, ?, ?)').run('k1', 0.9, '2026-01-01T00:00:00.000Z');
    expect(resolveMultiplierForKey(db, 'k1', '2026-06-01T00:00:00.000Z').factor).toBe(0.9);
  });

  it('uses the latest qualifying event effective before nowIso', () => {
    const db = setupDb();
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('k1', 2, '2026-05-02T00:00:00.000Z');
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('k1', 0.5, '2026-05-04T00:00:00.000Z');
    expect(resolveMultiplierForKey(db, 'k1', '2026-05-03T12:00:00.000Z').factor).toBe(2);
    expect(resolveMultiplierForKey(db, 'k1', '2026-05-05T00:00:00.000Z').factor).toBe(0.5);
  });

  it('returns factor 1 when no event has effective_at <= nowIso', () => {
    const db = setupDb();
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('k1', 0.5, '2099-01-01T00:00:00.000Z');
    expect(resolveMultiplierForKey(db, 'k1', '2026-05-01T00:00:00.000Z').factor).toBe(1);
  });

  it('collapses factor 0 to factor 1 (no-op)', () => {
    const db = setupDb();
    db.prepare('INSERT INTO key_policies (key_id, usage_multiplier, usage_multiplier_effective_at) VALUES (?, ?, ?)').run('k1', 0, '2026-01-01T00:00:00.000Z');
    expect(resolveMultiplierForKey(db, 'k1', '2026-06-01T00:00:00.000Z').factor).toBe(1);
  });

  it('collapses negative factor to factor 1 (no-op)', () => {
    const db = setupDb();
    db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run('k1', -0.5, '2026-01-01T00:00:00.000Z');
    expect(resolveMultiplierForKey(db, 'k1', '2026-06-01T00:00:00.000Z').factor).toBe(1);
  });
});

function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

async function runTransform(input: string, factor: number): Promise<string> {
  const transform = createUsageScalingSseTransform(factor);
  const source = Readable.from([Buffer.from(input, 'utf-8')]);
  source.pipe(transform);
  return collectStream(transform);
}

describe('createUsageScalingSseTransform', () => {
  it('scales a single complete event with usage', async () => {
    const input = `data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('"prompt_tokens":200');
    expect(out).toContain('"completion_tokens":100');
    expect(out).toContain('"total_tokens":300');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('passes through [DONE] unchanged', async () => {
    const input = `data: {"usage":{"prompt_tokens":100}}\n\ndata: [DONE]\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('"prompt_tokens":200');
    expect(out).toContain('data: [DONE]\n\n');
  });

  it('scales two events in one chunk', async () => {
    const input = `data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n`;
    const out = await runTransform(input, 3);
    expect(out).toContain('"id":"1"');
    expect(out).toContain('"prompt_tokens":30');
    expect(out).toContain('"completion_tokens":15');
  });

  it('handles event split across chunks', async () => {
    const transform = createUsageScalingSseTransform(2);
    const parts = [
      'data: {"usag',
      'e":{"prompt_tokens":100,"comple',
      'tion_tokens":50}}\n\ndata: [DONE]\n\n',
    ];
    const source = Readable.from(parts.map(p => Buffer.from(p, 'utf-8')));
    source.pipe(transform);
    const out = await collectStream(transform);
    expect(out).toContain('"prompt_tokens":200');
    expect(out).toContain('"completion_tokens":100');
    expect(out).toContain('data: [DONE]\n\n');
  });

  it('preserves event:/id:/retry: lines and only mutates data:', async () => {
    const input = `event: message_start\nid: abc\nretry: 1000\ndata: {"usage":{"prompt_tokens":10}}\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('event: message_start');
    expect(out).toContain('id: abc');
    expect(out).toContain('retry: 1000');
    expect(out).toContain('"prompt_tokens":20');
  });

  it('passes through malformed JSON as-is', async () => {
    const input = `data: not-json\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('data: not-json');
  });

  it('passes through events without usage as-is', async () => {
    const input = `data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('"id":"1"');
    // Body must be byte-identical to original (no JSON re-serialization reshuffle).
    expect(out).toBe(input);
  });

  it('flushes trailing partial event on stream end', async () => {
    const input = `data: {"usage":{"prompt_tokens":10}}\n\ndata: {"usage":{"prompt_tokens":20}}`; // missing trailing \n\n
    const out = await runTransform(input, 2);
    expect(out).toContain('"prompt_tokens":20');
    expect(out).toContain('"prompt_tokens":40');
  });

  it('scales Anthropic-style usage nested under message.usage', async () => {
    const input = `data: {"type":"message_delta","message":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\n`;
    const out = await runTransform(input, 2);
    expect(out).toContain('"input_tokens":200');
    expect(out).toContain('"output_tokens":100');
  });
});