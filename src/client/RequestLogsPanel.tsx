import { useEffect, useRef, useState } from 'react';
import type { UsageEventLogRow, UsageEventsLogResponse } from '../shared/types';
import { api } from './api';
import { fmt, vnDateTime, toVnInput, fromVnInput } from './format';
import { dict, type Lang } from './i18n';
import {
  applyPreset,
  buildLogsQuery,
  defaultLogsFilters,
  formatCost,
  pagerLabel,
  type LogsFilters,
  type LogsHistoryEntry,
  type LogsRangePreset,
} from './requestLogs';

export function RequestLogsPanel({ keyId, lang }: { keyId: string; lang: Lang }) {
  const t = dict[lang];
  const [filters, setFilters] = useState<LogsFilters>(() => defaultLogsFilters());
  const [history, setHistory] = useState<LogsHistoryEntry[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);

  // Monotonic request id — used to discard stale responses after filter changes.
  const reqIdRef = useRef(0);

  const current = history[history.length - 1];

  // Load model dropdown whenever the key or the time range changes.
  useEffect(() => {
    let alive = true;
    setModelsLoading(true);
    const params = new URLSearchParams();
    if (filters.fromIso) params.set('from', filters.fromIso);
    if (filters.toIso) params.set('to', filters.toIso);
    const qs = params.toString();
    api<string[]>(`/api/keys/${encodeURIComponent(keyId)}/usage-events/models${qs ? `?${qs}` : ''}`)
      .then(m => { if (alive) setModels(m); })
      .catch(() => { if (alive) setModels([]); })
      .finally(() => { if (alive) setModelsLoading(false); });
    return () => { alive = false; };
  }, [keyId, filters.fromIso, filters.toIso]);

  // Reset history when filters change (but not when navigating pages).
  useEffect(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    api<UsageEventsLogResponse>(`/api/keys/${encodeURIComponent(keyId)}/usage-events?${buildLogsQuery(filters, null)}`)
      .then(r => {
        if (reqId !== reqIdRef.current) return;
        setHistory([{ cursor: null, nextCursor: r.nextCursor, filters, rows: r.rows, hasMore: r.hasMore }]);
      })
      .catch(e => { if (reqId === reqIdRef.current) setError(e.message ?? String(e)); })
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
    return () => { /* requestId bumped; in-flight responses will be ignored */ };
  }, [keyId, filters]);

  function loadNext() {
    if (loading) return;
    const last = history[history.length - 1];
    if (!last?.hasMore || !last.nextCursor) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    api<UsageEventsLogResponse>(`/api/keys/${encodeURIComponent(keyId)}/usage-events?${buildLogsQuery(filters, last.nextCursor)}`)
      .then(r => {
        if (reqId !== reqIdRef.current) return;
        setHistory(h => [...h, { cursor: last.nextCursor, nextCursor: r.nextCursor, filters, rows: r.rows, hasMore: r.hasMore }]);
      })
      .catch(e => { if (reqId === reqIdRef.current) setError(e.message ?? String(e)); })
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
  }

  function loadPrev() {
    if (loading) return;
    if (history.length <= 1) return;
    setHistory(h => h.slice(0, -1));
  }

  function refresh() {
    if (loading) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    api<UsageEventsLogResponse>(`/api/keys/${encodeURIComponent(keyId)}/usage-events?${buildLogsQuery(filters, null)}`)
      .then(r => {
        if (reqId !== reqIdRef.current) return;
        setHistory([{ cursor: null, nextCursor: r.nextCursor, filters, rows: r.rows, hasMore: r.hasMore }]);
      })
      .catch(e => { if (reqId === reqIdRef.current) setError(e.message ?? String(e)); })
      .finally(() => { if (reqId === reqIdRef.current) setLoading(false); });
  }

  function onPreset(preset: LogsRangePreset) {
    setFilters(f => applyPreset(f, preset));
  }

  const rows = current?.rows ?? [];

  return <section>
    <h2>{t.requestLogs}</h2>
    <div className="logsFilters">
      <label>
        <span>{t.range}</span>
        <select value={filters.range} onChange={e => onPreset(e.target.value as LogsRangePreset)}>
          <option value="7d">{t.range7d}</option>
          <option value="30d">{t.range30d}</option>
          <option value="90d">{t.range90d}</option>
          <option value="custom">{t.rangeCustom}</option>
        </select>
      </label>
      {filters.range === 'custom' && <>
        <label>
          <span>{t.from}</span>
          <input
            type="datetime-local"
            value={toVnInput(filters.fromIso)}
            onChange={e => setFilters(f => ({ ...f, fromIso: fromVnInput(e.target.value) ?? '' }))}
          />
        </label>
        <label>
          <span>{t.to}</span>
          <input
            type="datetime-local"
            value={toVnInput(filters.toIso)}
            onChange={e => setFilters(f => ({ ...f, toIso: fromVnInput(e.target.value) ?? '' }))}
          />
        </label>
      </>}
      <label>
        <span>{t.modelName}</span>
        <select value={filters.model} onChange={e => setFilters(f => ({ ...f, model: e.target.value }))}>
          <option value="">—</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
          {modelsLoading && <option value="" disabled>…</option>}
        </select>
      </label>
      <label>
        <span>{t.cache}</span>
        <select value={filters.cache} onChange={e => setFilters(f => ({ ...f, cache: e.target.value as LogsFilters['cache'] }))}>
          <option value="any">{t.cacheAll}</option>
          <option value="read">{t.cacheReadOnly}</option>
          <option value="write">{t.cacheWriteOnly}</option>
          <option value="none">{t.cacheNone}</option>
        </select>
      </label>
      <label>
        <span>{t.provider}</span>
        <input
          type="text"
          value={filters.provider}
          onChange={e => setFilters(f => ({ ...f, provider: e.target.value }))}
          // Provider input would otherwise refetch on every keystroke. We commit
          // the filter locally but only trigger the actual fetch on blur/Enter.
          onBlur={() => setFilters(f => ({ ...f }))}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <label>
        <span>{t.pageSize}</span>
        <select value={String(filters.pageSize)} onChange={e => setFilters(f => ({ ...f, pageSize: Number(e.target.value) as 50 | 100 | 200 }))}>
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </label>
      <button type="button" onClick={refresh}>{t.refresh}</button>
    </div>

    {error && <pre className="error">{error}</pre>}

    {rows.length === 0 ? <p>{loading ? t.loading : t.noLogs}</p> : <section className="tableWrap"><table>
      <thead><tr>
        <th>{t.last}</th>
        <th>{t.modelName}</th>
        <th>{t.prompt}</th>
        <th>{t.completion}</th>
        <th>{t.totalTokens}</th>
        <th>{t.cacheRead}</th>
        <th>{t.cacheWrite}</th>
        <th>{t.cost}</th>
        <th>{t.provider}</th>
      </tr></thead>
      <tbody>{rows.map(r => <LogRow key={r.id} row={r} />)}</tbody>
    </table></section>}

    <div className="pager">
      <button type="button" onClick={loadPrev} disabled={history.length <= 1 || loading}>← {t.prev}</button>
      <button type="button" onClick={loadNext} disabled={loading || !current?.hasMore}>{t.next} →</button>
      <span>{pagerLabel(history)}</span>
    </div>
  </section>;
}

function LogRow({ row }: { row: UsageEventLogRow }) {
  return <tr>
    <td>{vnDateTime(row.timestamp)}</td>
    <td><code>{row.model ?? '—'}</code></td>
    <td>{fmt(row.promptTokens)}</td>
    <td>{fmt(row.completionTokens)}</td>
    <td>{fmt(row.totalTokens)}</td>
    <td>{row.cacheReadTokens == null ? '—' : fmt(row.cacheReadTokens)}</td>
    <td>{row.cacheCreationTokens == null ? '—' : fmt(row.cacheCreationTokens)}</td>
    <td>{formatCost(row.cost)}</td>
    <td>{row.provider ?? '—'}{row.connectionId ? ` · ${row.connectionId}` : ''}</td>
  </tr>;
}