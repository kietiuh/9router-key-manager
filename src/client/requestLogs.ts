import type { UsageEventLogRow } from '../shared/types';

export type LogsRangePreset = '7d' | '30d' | '90d' | 'custom';

export type LogsFilters = {
  range: LogsRangePreset;
  fromIso: string;
  toIso: string;
  model: string;
  provider: string;
  cache: 'any' | 'read' | 'write' | 'none';
  pageSize: 50 | 100 | 200;
};

export type LogsHistoryEntry = {
  /** Cursor used to fetch this page; null for the first page. */
  cursor: string | null;
  /** Cursor to fetch the next page after this one; null when there is no next page. */
  nextCursor: string | null;
  filters: LogsFilters;
  rows: UsageEventLogRow[];
  hasMore: boolean;
};

/** ISO window for a preset. Both bounds are inclusive ISO strings. */
export function rangeForPreset(preset: LogsRangePreset): { fromIso: string; toIso: string } {
  if (preset === 'custom') {
    return { fromIso: '', toIso: '' };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** Build a URLSearchParams string from the active filters and an optional cursor. */
export function buildLogsQuery(filters: LogsFilters, cursor: string | null): string {
  const sp = new URLSearchParams();
  if (filters.fromIso) sp.set('from', filters.fromIso);
  if (filters.toIso) sp.set('to', filters.toIso);
  if (filters.model) sp.set('model', filters.model);
  if (filters.provider) sp.set('provider', filters.provider);
  if (filters.cache !== 'any') sp.set('cache', filters.cache);
  sp.set('pageSize', String(filters.pageSize));
  if (cursor) sp.set('cursor', cursor);
  return sp.toString();
}

/** Default first-page filters (last 30 days, any cache, 50 rows). */
export function defaultLogsFilters(now: Date = new Date()): LogsFilters {
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    range: '30d',
    fromIso: from.toISOString(),
    toIso: now.toISOString(),
    model: '',
    provider: '',
    cache: 'any',
    pageSize: 50,
  };
}

/**
 * Apply a preset to the current filters. For 'custom' the caller is expected to
 * set fromIso/toIso themselves; we keep whatever the user has typed.
 */
export function applyPreset(filters: LogsFilters, preset: LogsRangePreset): LogsFilters {
  if (preset === 'custom') return { ...filters, range: 'custom' };
  const { fromIso, toIso } = rangeForPreset(preset);
  return { ...filters, range: preset, fromIso, toIso };
}

/** Format cost as $X.XXXXXX. Null/undefined inputs return the placeholder. */
export function formatCost(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(6)}`;
}

/** "Showing N rows" string used in the pager label. */
export function pagerLabel(history: LogsHistoryEntry[]): string {
  const entry = history[history.length - 1];
  if (!entry) return '';
  return `Showing ${entry.rows.length} row${entry.rows.length === 1 ? '' : 's'}`;
}

/** Get the immediately previous entry, or null if at the start. */
export function previousEntry(history: LogsHistoryEntry[]): LogsHistoryEntry | null {
  return history.length >= 2 ? history[history.length - 2] : null;
}
