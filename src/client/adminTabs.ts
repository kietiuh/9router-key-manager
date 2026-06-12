import type { KeyStatus, KeyUsageSummary } from '../shared/types';
import type { Filter, Lang } from './i18n';

export const ADMIN_TAB_IDS = ['overview', 'keys', 'traffic', 'routing'] as const;
export type AdminTab = typeof ADMIN_TAB_IDS[number];
export const DEFAULT_ADMIN_TAB: AdminTab = 'overview';

export const ADMIN_FILTERS = ['attention', 'all', 'danger', 'warning', 'unlimited', 'expired', 'inactive', 'ok'] as const satisfies readonly Filter[];

const ATTENTION_STATUSES = new Set<KeyStatus>(['danger', 'expired', 'warning', 'unlimited']);

const ADMIN_TAB_LABELS: Record<Lang, Record<AdminTab, string>> = {
  en: { overview: 'Overview', keys: 'Keys', traffic: 'Traffic', routing: 'Routing' },
  vi: { overview: 'Tổng quan', keys: 'Key', traffic: 'Giám sát', routing: 'Routing' }
};

export function isKeyAttention(k: KeyUsageSummary) {
  return ATTENTION_STATUSES.has(k.status);
}

export function adminTabLabel(tab: AdminTab, lang: Lang) {
  return ADMIN_TAB_LABELS[lang][tab];
}

export function getAdminTabCounts(keys: KeyUsageSummary[], _unused: null): Partial<Record<AdminTab, number>> {
  const attention = keys.filter(isKeyAttention).length;
  return {
    overview: attention,
    keys: keys.length,
  };
}
