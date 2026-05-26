import type { ApiKeyRecord } from '../../shared/types.js';

export type ApiKeyLookupResult = {
  id: string;
  isActive?: boolean;
};

export type ApiKeyCache = {
  getKeys: (force?: boolean) => ApiKeyRecord[];
  lookup: (token: string) => ApiKeyLookupResult | undefined;
  invalidate: () => void;
};

export function createApiKeyCache(options: {
  load: () => ApiKeyRecord[];
  ttlMs: number;
  now?: () => number;
}): ApiKeyCache {
  const now = options.now ?? Date.now;
  let expiresAt = 0;
  let keys: ApiKeyRecord[] | null = null;

  function getKeys(force = false): ApiKeyRecord[] {
    const current = now();
    if (!force && keys && current < expiresAt) return keys;
    keys = options.load();
    expiresAt = current + Math.max(0, options.ttlMs);
    return keys;
  }

  return {
    getKeys,
    lookup(token: string) {
      const clean = token.trim();
      const match = getKeys().find(key => key.key === clean);
      return match ? { id: match.id, isActive: match.isActive } : undefined;
    },
    invalidate() {
      keys = null;
      expiresAt = 0;
    },
  };
}
