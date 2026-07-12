import { describe, expect, it } from 'vitest';
import type { ModelUsageSummary } from '../shared/types';
import { buildModelUsageRows, keyDetailPath, keyIdFromPath } from './keyDetail';

describe('keyIdFromPath', () => {
  it('extracts the id from a key-detail path', () => {
    expect(keyIdFromPath('/key/abc123')).toBe('abc123');
  });

  it('tolerates a trailing slash', () => {
    expect(keyIdFromPath('/key/abc123/')).toBe('abc123');
  });

  it('decodes url-encoded ids', () => {
    expect(keyIdFromPath('/key/a%2Fb')).toBe('a/b');
  });

  it('returns null for non key-detail paths', () => {
    expect(keyIdFromPath('/')).toBeNull();
    expect(keyIdFromPath('/check')).toBeNull();
    expect(keyIdFromPath('/key/')).toBeNull();
  });

  it('strips query string and hash so /key/abc?ref=foo#bar parses as abc', () => {
    expect(keyIdFromPath('/key/abc?ref=foo')).toBe('abc');
    expect(keyIdFromPath('/key/abc#bar')).toBe('abc');
    expect(keyIdFromPath('/key/abc?ref=foo#bar')).toBe('abc');
  });

  it('round-trips with keyDetailPath', () => {
    expect(keyIdFromPath(keyDetailPath('id with spaces'))).toBe('id with spaces');
  });
});

describe('buildModelUsageRows', () => {
  const usage: ModelUsageSummary[] = [
    { model: 'gpt-a', req: 3, prompt: 60, completion: 40, lastUsageAt: '2026-07-01T00:00:00.000Z' },
    { model: 'gpt-b', req: 1, prompt: 20, completion: 30, lastUsageAt: null },
  ];

  it('adds per-model total and share of the grand total', () => {
    const rows = buildModelUsageRows(usage);
    expect(rows[0]).toMatchObject({ model: 'gpt-a', total: 100, percentOfTotal: (100 / 150) * 100 });
    expect(rows[1]).toMatchObject({ model: 'gpt-b', total: 50, percentOfTotal: (50 / 150) * 100 });
    expect(rows[0].percentOfTotal + rows[1].percentOfTotal).toBeCloseTo(100);
  });

  it('preserves backend ordering', () => {
    expect(buildModelUsageRows(usage).map(r => r.model)).toEqual(['gpt-a', 'gpt-b']);
  });

  it('reports zero share when there are no tokens', () => {
    const rows = buildModelUsageRows([{ model: 'idle', req: 0, prompt: 0, completion: 0, lastUsageAt: null }]);
    expect(rows[0]).toMatchObject({ total: 0, percentOfTotal: 0 });
  });

  it('returns an empty array for no models', () => {
    expect(buildModelUsageRows([])).toEqual([]);
  });
});
