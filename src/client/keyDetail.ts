import type { KeyUsageSummary, ModelUsageSummary } from '../shared/types';

export const KEY_DETAIL_PREFIX = '/key/';

/** Extract the key id from a `/key/:id` pathname, or null if the path is not a key-detail route. */
export function keyIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(KEY_DETAIL_PREFIX)) return null;
  const tail = pathname.slice(KEY_DETAIL_PREFIX.length).split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const id = decodeURIComponent(tail);
  return id ? id : null;
}

/** Build the `/key/:id` path for a given key id. */
export function keyDetailPath(keyId: string): string {
  return `${KEY_DETAIL_PREFIX}${encodeURIComponent(keyId)}`;
}

/** Navigate to a path inside the SPA and trigger a re-render of pathname-aware components. */
export function navigateTo(path: string) {
  history.pushState({}, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

export type ModelUsageRow = ModelUsageSummary & {
  total: number;
  percentOfTotal: number;
};

/**
 * Turn a key's per-model usage into rows for display. Tokens are already
 * adjusted by the usage multiplier upstream, so no further scaling happens here.
 * Rows keep the backend ordering (most requests first) and gain total + share.
 */
export function buildModelUsageRows(modelUsage: ModelUsageSummary[]): ModelUsageRow[] {
  const grandTotal = modelUsage.reduce((sum, m) => sum + m.prompt + m.completion, 0);
  return modelUsage.map(m => {
    const total = m.prompt + m.completion;
    return { ...m, total, percentOfTotal: grandTotal > 0 ? (total / grandTotal) * 100 : 0 };
  });
}

export function findKeyById(keys: KeyUsageSummary[], keyId: string): KeyUsageSummary | null {
  return keys.find(k => k.keyId === keyId) ?? null;
}
