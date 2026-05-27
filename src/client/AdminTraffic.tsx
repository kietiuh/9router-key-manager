import type { TrafficSummary } from '../shared/types';
import { fmt, vnDateTime } from './format';

function fmtMs(value: number) {
  if (!value) return '0 ms';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  return `${fmt(value)} ms`;
}

function percent(part: number, total: number) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function TrafficPanel({ summary, error }: { summary: TrafficSummary | null; error?: string }) {
  if (error) return <section className="card"><h2>Giám sát request</h2><p>Chưa đọc được dữ liệu giám sát: {error}</p></section>;
  if (!summary) return <section className="card"><h2>Giám sát request</h2><p>Chưa có dữ liệu giám sát trong phiên chạy hiện tại.</p></section>;
  const latestText = summary.latestEventAt ? vnDateTime(summary.latestEventAt) : 'Chưa có request trong cửa sổ hiện tại';
  const recentBuckets = summary.buckets.slice(-12).reverse();
  const maxBucketRequests = Math.max(1, ...recentBuckets.map(bucket => bucket.requestCount));
  const streamCount = summary.streamCount ?? 0;

  return <section className="trafficPanel">
    <div className="panelHeader"><div><h2>Giám sát 9router</h2><p>Đọc log service 9router trong {summary.windowMinutes} phút gần nhất, cập nhật nền mỗi khoảng {summary.bucketMinutes} phút để không ảnh hưởng request.</p>{summary.error && <p className="formError">Lỗi đọc log gần nhất: {summary.error}</p>}</div><span className="pill">Dữ liệu mới nhất: {latestText}</span></div>
    <div className="trafficStatsGrid">
      <div className="card"><span>Request</span><strong>{fmt(summary.requestCount)}</strong></div>
      <div className="card"><span>Stream hoàn thành</span><strong>{fmt(streamCount)}</strong></div>
      <div className="card"><span>Disconnect/abort</span><strong>{fmt(summary.errorCount)}</strong><small>{percent(summary.errorCount, streamCount)}</small></div>
      <div className="card"><span>Thời gian AVG</span><strong>{fmtMs(summary.upstreamMs.avg)}</strong><small>Max: {fmtMs(summary.upstreamMs.max)}</small></div>
    </div>
    <div className="trafficColumns">
      <section className="card"><h3>Timeline gần nhất</h3>{recentBuckets.length ? <div className="trafficBars">{recentBuckets.map(bucket => <div className="trafficBar" key={bucket.bucketStart}><span>{vnDateTime(bucket.bucketStart)}</span><div><b style={{ width: `${Math.max(4, (bucket.requestCount / maxBucketRequests) * 100)}%` }} /></div><em>{fmt(bucket.requestCount)} req · stream {fmt(bucket.streamCount ?? 0)} · abort {fmt(bucket.errorCount)} · avg {fmtMs(bucket.avgUpstreamMs)}</em></div>)}</div> : <p>Chưa có request.</p>}</section>
      <section className="card"><h3>Model nhiều request/chậm</h3>{summary.models.length ? <div className="tableWrap"><table><thead><tr><th>Model</th><th>Req</th><th>Stream</th><th>Abort</th><th>Avg stream</th><th>Max stream</th></tr></thead><tbody>{summary.models.map(model => <tr key={model.model}><td>{model.model}</td><td>{fmt(model.requestCount)}</td><td>{fmt(model.streamCount ?? 0)}</td><td>{fmt(model.errorCount)}</td><td>{fmtMs(model.avgUpstreamMs)}</td><td>{fmtMs(model.maxUpstreamMs)}</td></tr>)}</tbody></table></div> : <p>Chưa có dữ liệu model.</p>}</section>
    </div>
  </section>;
}
