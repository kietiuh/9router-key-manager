import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { ingestUsageHistory } from './usageStore.js';
import {
  defaultRange,
  distinctModelsForKey,
  encodeCursor,
  listUsageEventsForKey,
  parseCursor,
} from './usageEventsList.js';

function db() {
  const d = new Database(':memory:');
  migrate(d);
  return d;
}

function seed(d: Database.Database, apiKey: string, count: number, baseIso: string, extra: Record<string, unknown> = {}) {
  const base = Date.parse(baseIso);
  const rows = Array.from({ length: count }, (_, i) => ({
    apiKey,
    model: (extra.model as string) ?? 'm',
    provider: (extra.provider as string) ?? 'p',
    connectionId: `c${i}`,
    timestamp: new Date(base + i * 1000).toISOString(),
    cost: 0.001,
    tokens: {
      prompt_tokens: 10 + i,
      completion_tokens: 5 + i,
      total_tokens: 15 + 2 * i,
      cache_read_input_tokens: (extra.cacheRead as number) ?? 0,
      cache_creation_input_tokens: (extra.cacheWrite as number) ?? 0,
    },
  }));
  ingestUsageHistory(d, rows);
}

describe('parseCursor / encodeCursor', () => {
  it('round-trips a cursor', () => {
    const c = { ts: '2026-07-01T00:00:00.000Z', id: 42 };
    expect(parseCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for missing input', () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor('')).toBeNull();
  });

  it('returns null for malformed cursor', () => {
    expect(parseCursor('not-base64!!')).toBeNull();
    expect(parseCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
    expect(parseCursor(Buffer.from('2026-07-01T00:00:00.000Z|-1').toString('base64url'))).toBeNull();
    expect(parseCursor(Buffer.from('2026-07-01T00:00:00.000Z|abc').toString('base64url'))).toBeNull();
  });
});

describe('defaultRange', () => {
  it('spans 30 days ending now', () => {
    const { fromIso, toIso } = defaultRange();
    const span = Date.parse(toIso) - Date.parse(fromIso);
    expect(Math.round(span / (24 * 60 * 60 * 1000))).toBe(30);
  });
});

describe('listUsageEventsForKey', () => {
  it('returns rows newest-first with cache columns', () => {
    const d = db();
    seed(d, 'sk-a', 3, '2026-07-01T00:00:00.000Z', { cacheRead: 7, cacheWrite: 3 });
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(3);
    expect(page.rows[0].timestamp > page.rows[1].timestamp).toBe(true);
    expect(page.rows[0].cacheReadTokens).toBe(7);
    expect(page.rows[0].cacheCreationTokens).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates via cursor without gaps or repeats', () => {
    const d = db();
    seed(d, 'sk-a', 5, '2026-07-01T00:00:00.000Z');
    const first = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 2,
    });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 2,
      cursor: first.nextCursor,
    });
    const third = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 2,
      cursor: second.nextCursor,
    });
    const ids = [...first.rows, ...second.rows, ...third.rows].map(r => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it('filters by model', () => {
    const d = db();
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z', { model: 'alpha' });
    seed(d, 'sk-a', 2, '2026-07-02T00:00:00.000Z', { model: 'beta' });
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      model: 'alpha',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every(r => r.model === 'alpha')).toBe(true);
  });

  it('filters by cache=read', () => {
    const d = db();
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z', { cacheRead: 5 });
    seed(d, 'sk-a', 2, '2026-07-03T00:00:00.000Z', { cacheRead: 0 });
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      cache: 'read',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every(r => (r.cacheReadTokens ?? 0) > 0)).toBe(true);
  });

  it('filters by cache=none', () => {
    const d = db();
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z', { cacheRead: 5, cacheWrite: 1 });
    seed(d, 'sk-a', 3, '2026-07-03T00:00:00.000Z', { cacheRead: 0, cacheWrite: 0 });
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      cache: 'none',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(3);
  });

  it('restricts to the time window', () => {
    const d = db();
    seed(d, 'sk-a', 3, '2026-05-01T00:00:00.000Z');
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z');
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(2);
  });

  it('scopes rows to the requested key', () => {
    const d = db();
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z');
    seed(d, 'sk-b', 3, '2026-07-01T00:00:00.000Z');
    const page = listUsageEventsForKey(d, {
      apiKey: 'sk-b',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
      pageSize: 50,
    });
    expect(page.rows).toHaveLength(3);
  });
});

describe('distinctModelsForKey', () => {
  it('returns distinct models within the window', () => {
    const d = db();
    seed(d, 'sk-a', 2, '2026-07-01T00:00:00.000Z', { model: 'alpha' });
    seed(d, 'sk-a', 2, '2026-07-02T00:00:00.000Z', { model: 'beta' });
    const models = distinctModelsForKey(d, {
      apiKey: 'sk-a',
      fromIso: '2026-06-01T00:00:00.000Z',
      toIso: '2026-08-01T00:00:00.000Z',
    });
    expect(models.sort()).toEqual(['alpha', 'beta']);
  });
});
