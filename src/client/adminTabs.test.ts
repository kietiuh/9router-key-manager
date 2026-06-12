import { describe, expect, it } from 'vitest';
import type { KeyUsageSummary } from '../shared/types';
import { ADMIN_FILTERS, ADMIN_TAB_IDS, adminTabLabel, getAdminTabCounts, isKeyAttention } from './adminTabs';

function key(status: KeyUsageSummary['status'], isActive = true): KeyUsageSummary {
  return {
    keyId: `${status}-${isActive}`,
    name: status,
    keyMasked: 'sk-***',
    isActive,
    status,
    statusReason: '',
    windowStart: '2026-01-01T00:00:00.000Z',
    resetPolicy: 'daily',
    tokenLimit: null,
    actionOnLimit: 'alert',
    usageMultiplier: 1,
    actualPrompt: 0,
    actualCompletion: 0,
    actualTotal: 0,
    dedupedRequests: 0,
    duplicateRequests: 0,
    duplicateTokens: 0,
    req: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cost: 0,
    models: {},
    modelUsage: []
  };
}

describe('admin tab helpers', () => {
  it('keeps risky key statuses grouped as attention', () => {
    expect(isKeyAttention(key('danger'))).toBe(true);
    expect(isKeyAttention(key('expired'))).toBe(true);
    expect(isKeyAttention(key('warning'))).toBe(true);
    expect(isKeyAttention(key('unlimited'))).toBe(true);
    expect(isKeyAttention(key('ok'))).toBe(false);
  });

  it('counts dashboard tabs from current data', () => {
    const counts = getAdminTabCounts([key('danger'), key('ok'), key('inactive', false)], null);
    expect(counts.overview).toBe(1);
    expect(counts.keys).toBe(3);
    expect(counts.traffic).toBeUndefined();
    expect(counts.routing).toBeUndefined();
  });

  it('adds a traffic monitoring tab with Vietnamese label', () => {
    expect(ADMIN_TAB_IDS).toContain('traffic');
    expect(adminTabLabel('traffic', 'vi')).toBe('Giám sát');
  });

  it('keeps key filters in their display order', () => {
    expect(ADMIN_FILTERS).toEqual(['attention', 'all', 'danger', 'warning', 'unlimited', 'expired', 'inactive', 'ok']);
  });
});
