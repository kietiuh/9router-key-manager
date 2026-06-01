import { useEffect, useState } from 'react';
import type { ModelRateLimitConfig, ModelRateLimitRule, TrafficSummary } from '../shared/types';
import { fmt, vnDateTime } from './format';

type RateLimitDraftRule = Omit<ModelRateLimitRule, 'maxQueueWaitMs'> & { maxQueueWaitSeconds: number };

function fmtMs(value: number) {
  if (!value) return '0 ms';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  return `${fmt(value)} ms`;
}

function percent(part: number, total: number) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function draftRules(config: ModelRateLimitConfig | null): RateLimitDraftRule[] {
  return (config?.rules ?? []).map(rule => ({
    model: rule.model,
    enabled: rule.enabled,
    rpm: rule.rpm,
    queueLimit: rule.queueLimit,
    maxQueueWaitSeconds: Math.round(rule.maxQueueWaitMs / 1000),
  }));
}

function newRule(): RateLimitDraftRule {
  return { model: '', enabled: true, rpm: 12, queueLimit: 100, maxQueueWaitSeconds: 300 };
}

function buildConfig(enabled: boolean, rules: RateLimitDraftRule[]): ModelRateLimitConfig {
  return {
    enabled,
    rules: rules.map(rule => ({
      model: rule.model.trim(),
      enabled: rule.enabled,
      rpm: Math.max(1, Number(rule.rpm) || 12),
      queueLimit: Math.max(0, Math.floor(Number(rule.queueLimit) || 0)),
      maxQueueWaitMs: Math.max(1000, Math.floor(Number(rule.maxQueueWaitSeconds) || 300) * 1000),
    })).filter(rule => rule.model),
  };
}

function RateLimitConfigPanel({ config, saving, onSave }: { config: ModelRateLimitConfig | null; saving: boolean; onSave: (cfg: ModelRateLimitConfig) => Promise<void> }) {
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<RateLimitDraftRule[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setEnabled(Boolean(config?.enabled));
    setRules(draftRules(config));
  }, [config, dirty]);

  const patchRule = (idx: number, patch: Partial<RateLimitDraftRule>) => {
    setDirty(true);
    setRules(rules.map((rule, i) => i === idx ? { ...rule, ...patch } : rule));
  };
  const save = async () => {
    await onSave(buildConfig(enabled, rules));
    setDirty(false);
  };

  return <section className="card rateLimitConfig">
    <div className="panelHeader"><div><h3>Giới hạn RPM theo model</h3><p>Chỉ model có rule đang bật mới chờ theo RPM; model khác đi thẳng.</p></div><span className={enabled ? 'pill ok' : 'pill inactive'}>{enabled ? 'Đang bật' : 'Đang tắt'}</span></div>
    <label><input type="checkbox" checked={enabled} onChange={e => { setDirty(true); setEnabled(e.target.checked); }} /> Bật giới hạn RPM</label>
    <div className="rateLimitRules">
      {rules.map((rule, idx) => <div className="rateLimitRule" key={idx}>
        <label><input type="checkbox" checked={rule.enabled} onChange={e => patchRule(idx, { enabled: e.target.checked })} /> Rule bật</label>
        <label>Model đích<input value={rule.model} onChange={e => patchRule(idx, { model: e.target.value })} placeholder="v4/gpt-5.5" /></label>
        <label>RPM<input type="number" min={1} value={rule.rpm} onChange={e => patchRule(idx, { rpm: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label>Queue<input type="number" min={0} value={rule.queueLimit} onChange={e => patchRule(idx, { queueLimit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
        <label>Max chờ (giây)<input type="number" min={1} value={rule.maxQueueWaitSeconds} onChange={e => patchRule(idx, { maxQueueWaitSeconds: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} /></label>
        <button type="button" onClick={() => { setDirty(true); setRules(rules.filter((_, i) => i !== idx)); }}>Xóa</button>
      </div>)}
      {!rules.length && <p>Chưa có model nào bị giới hạn RPM.</p>}
    </div>
    <div className="actions"><button type="button" onClick={() => { setDirty(true); setRules([...rules, newRule()]); }}>Thêm model</button><button onClick={save} disabled={saving}>{saving ? 'Đang lưu...' : 'Lưu cấu hình RPM'}{dirty ? ' *' : ''}</button></div>
  </section>;
}

export function TrafficPanel({ summary, error, modelRateLimitConfig, savingModelRateLimit, onSaveModelRateLimit }: { summary: TrafficSummary | null; error?: string; modelRateLimitConfig: ModelRateLimitConfig | null; savingModelRateLimit: boolean; onSaveModelRateLimit: (cfg: ModelRateLimitConfig) => Promise<void> }) {
  if (error) return <section className="trafficPanel"><RateLimitConfigPanel config={modelRateLimitConfig} saving={savingModelRateLimit} onSave={onSaveModelRateLimit} /><section className="card"><h2>Giám sát request</h2><p>Chưa đọc được dữ liệu giám sát: {error}</p></section></section>;
  if (!summary) return <section className="trafficPanel"><RateLimitConfigPanel config={modelRateLimitConfig} saving={savingModelRateLimit} onSave={onSaveModelRateLimit} /><section className="card"><h2>Giám sát request</h2><p>Chưa có dữ liệu giám sát trong phiên chạy hiện tại.</p></section></section>;
  const latestText = summary.latestEventAt ? vnDateTime(summary.latestEventAt) : 'Chưa có request trong cửa sổ hiện tại';
  const recentBuckets = summary.buckets.slice(-12).reverse();
  const maxBucketRequests = Math.max(1, ...recentBuckets.map(bucket => bucket.requestCount));
  const streamCount = summary.streamCount ?? 0;

  return <section className="trafficPanel">
    <RateLimitConfigPanel config={modelRateLimitConfig} saving={savingModelRateLimit} onSave={onSaveModelRateLimit} />
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
