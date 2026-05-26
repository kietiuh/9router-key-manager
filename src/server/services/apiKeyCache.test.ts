import { describe, expect, it } from 'vitest';
import { createApiKeyCache } from './apiKeyCache.js';
import type { ApiKeyRecord } from '../../shared/types.js';

function key(id: string, apiKey = `sk-${id}`, active = true): ApiKeyRecord {
  return { id, name: id, key: apiKey, isActive: active };
}

describe('apiKeyCache', () => {
  it('reuses loaded keys within the ttl', () => {
    const now = 1000;
    let calls = 0;
    const cache = createApiKeyCache({
      ttlMs: 5000,
      now: () => now,
      load: () => {
        calls++;
        return [key('a')];
      },
    });

    expect(cache.getKeys().map(k => k.id)).toEqual(['a']);
    expect(cache.getKeys().map(k => k.id)).toEqual(['a']);
    expect(calls).toBe(1);
  });

  it('refreshes after ttl expiry', () => {
    let now = 1000;
    let calls = 0;
    const cache = createApiKeyCache({
      ttlMs: 5000,
      now: () => now,
      load: () => [key(calls++ === 0 ? 'a' : 'b')],
    });

    expect(cache.getKeys().map(k => k.id)).toEqual(['a']);
    now = 7001;
    expect(cache.getKeys().map(k => k.id)).toEqual(['b']);
    expect(calls).toBe(2);
  });

  it('supports explicit invalidation', () => {
    let calls = 0;
    const cache = createApiKeyCache({
      ttlMs: 60000,
      load: () => [key(calls++ === 0 ? 'a' : 'b')],
    });

    expect(cache.lookup('sk-a')?.id).toBe('a');
    cache.invalidate();
    expect(cache.lookup('sk-b')?.id).toBe('b');
  });

  it('trims lookup tokens and preserves inactive state', () => {
    const cache = createApiKeyCache({
      ttlMs: 60000,
      load: () => [key('inactive', 'sk-inactive', false)],
    });

    expect(cache.lookup('  sk-inactive  ')).toEqual({ id: 'inactive', isActive: false });
    expect(cache.lookup('sk-missing')).toBeUndefined();
  });
});
