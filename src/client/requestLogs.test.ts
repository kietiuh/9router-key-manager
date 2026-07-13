import { describe, expect, it } from 'vitest';
import type { UsageEventLogRow } from '../shared/types';
import { applyPreset, buildLogsQuery, defaultLogsFilters, formatCost, pagerLabel, previousEntry, type LogsHistoryEntry } from './requestLogs';

describe('requestLogs helpers', () => {
  it('builds a query with optional filters and cursor', () => {
    const q = buildLogsQuery({
      range: 'custom',
      fromIso: '2026-07-01T00:00:00.000Z',
      toIso: '2026-07-13T00:00:00.000Z',
      model: 'gpt/a',
      provider: 'provider x',
      cache: 'read',
      pageSize: 100,
    }, 'abc=');
    const sp = new URLSearchParams(q);
    expect(sp.get('from')).toBe('2026-07-01T00:00:00.000Z');
    expect(sp.get('to')).toBe('2026-07-13T00:00:00.000Z');
    expect(sp.get('model')).toBe('gpt/a');
    expect(sp.get('provider')).toBe('provider x');
    expect(sp.get('cache')).toBe('read');
    expect(sp.get('pageSize')).toBe('100');
    expect(sp.get('cursor')).toBe('abc=');
  });

  it('omits empty optional filters', () => {
    const q = buildLogsQuery({
      range: '30d',
      fromIso: '2026-06-13T00:00:00.000Z',
      toIso: '2026-07-13T00:00:00.000Z',
      model: '',
      provider: '',
      cache: 'any',
      pageSize: 50,
    }, null);
    const sp = new URLSearchParams(q);
    expect(sp.has('model')).toBe(false);
    expect(sp.has('provider')).toBe(false);
    expect(sp.has('cache')).toBe(false);
    expect(sp.has('cursor')).toBe(false);
  });

  it('defaults to the last 30 days and 50 rows', () => {
    const f = defaultLogsFilters(new Date('2026-07-13T12:00:00.000Z'));
    expect(f.fromIso).toBe('2026-06-13T12:00:00.000Z');
    expect(f.toIso).toBe('2026-07-13T12:00:00.000Z');
    expect(f.pageSize).toBe(50);
    expect(f.cache).toBe('any');
  });

  it('applies range presets', () => {
    const f = defaultLogsFilters(new Date('2026-07-13T12:00:00.000Z'));
    const seven = applyPreset(f, '7d');
    expect(Date.parse(seven.toIso) - Date.parse(seven.fromIso)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(seven.range).toBe('7d');
    expect(applyPreset(f, 'custom').fromIso).toBe(f.fromIso);
  });

  it('formats cost safely', () => {
    expect(formatCost(0.0012345)).toBe('$0.001234');
    expect(formatCost(null)).toBe('—');
  });

  it('computes pager label and previous entry', () => {
    const filters = defaultLogsFilters(new Date('2026-07-13T12:00:00.000Z'));
    const r = (id: number): UsageEventLogRow => ({ id, timestamp: '2026-07-13T00:00:00.000Z', model: null, provider: null, connectionId: null, promptTokens: null, completionTokens: null, totalTokens: null, cacheReadTokens: null, cacheCreationTokens: null, cost: null });
    const first: LogsHistoryEntry = { cursor: null, nextCursor: 'c1', filters, rows: [r(1)], hasMore: true };
    const second: LogsHistoryEntry = { cursor: 'c1', nextCursor: null, filters, rows: [r(2), r(3)], hasMore: false };
    expect(pagerLabel([first, second])).toBe('Showing 2 rows');
    expect(previousEntry([first, second])).toBe(first);
    expect(previousEntry([first])).toBeNull();
  });
});
