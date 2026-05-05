import React, { useEffect, useMemo, useState } from 'react';
import type { ConfigStatus, ImageUsageSummary, KeyUsageSummary, ModelRewriteConfig } from '../shared/types';
import { api } from './api';
import { fmt, fromVnInput, pct, vnDateTime } from './format';
import { dict, filterLabel, recommendation, statusLabel, type Filter, type Lang } from './i18n';
import { KeyDrawer } from './KeyDrawer';

type Audit = { id: number; key_id?: string; action: string; message: string; created_at: string };

type RewriteDraftRule = { id?: number; enabled: boolean; fromModel: string; toModel: string; note?: string | null };

function ModelRewritePanel({ config, onSave, saving }: { config: ModelRewriteConfig | null; onSave: (cfg: { enabled: boolean; rules: RewriteDraftRule[] }) => Promise<void>; saving: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState<RewriteDraftRule[]>([]);
  useEffect(() => { setEnabled(Boolean(config?.enabled)); setRules(config?.rules?.map(r => ({ id: r.id, enabled: r.enabled, fromModel: r.fromModel, toModel: r.toModel, note: r.note })) ?? []); }, [config]);
  const addRule = () => setRules([...rules, { enabled: true, fromModel: '', toModel: '', note: '' }]);
  const patchRule = (idx: number, patch: Partial<RewriteDraftRule>) => setRules(rules.map((r, i) => i === idx ? { ...r, ...patch } : r));
  const removeRule = (idx: number) => setRules(rules.filter((_, i) => i !== idx));
  return <section className="attention"><h2>Cấu hình nâng cao — Model rewrite</h2><p>Soft OFF: tắt global là proxy không rewrite model. Khi bật, chỉ model khớp rule mới đổi A → B; model không khớp forward nguyên body.</p><label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable model rewrite</label><div className="rewriteList">{rules.map((r, i) => <div className="rewriteRule" key={i}><label><input type="checkbox" checked={r.enabled} onChange={e => patchRule(i, { enabled: e.target.checked })} /> Rule enabled</label><label>From model<input value={r.fromModel} onChange={e => patchRule(i, { fromModel: e.target.value })} placeholder="v1/cx/gpt-5.5" /></label><label>To model<input value={r.toModel} onChange={e => patchRule(i, { toModel: e.target.value })} placeholder="cx/gpt-5.5" /></label><label>Note<input value={r.note ?? ''} onChange={e => patchRule(i, { note: e.target.value })} placeholder="optional" /></label><button type="button" onClick={() => removeRule(i)}>Remove</button></div>)}</div><div className="actions"><button type="button" onClick={addRule}>Add rule</button><button onClick={() => onSave({ enabled, rules })} disabled={saving}>{saving ? 'Saving...' : 'Save rewrite config'}</button></div></section>;
}

function attention(k: KeyUsageSummary) {
  return ['danger', 'expired', 'warning', 'unlimited'].includes(k.status);
}

export function Dashboard({ lang, setLang, onLogout }: { lang: Lang; setLang: (l: Lang) => void; onLogout: () => void }) {
  const t = dict[lang];
  const [keys, setKeys] = useState<KeyUsageSummary[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [images, setImages] = useState<ImageUsageSummary | null>(null);
  const [rewriteConfig, setRewriteConfig] = useState<ModelRewriteConfig | null>(null);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [selected, setSelected] = useState<KeyUsageSummary | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');

  async function refresh() {
    try {
      setError('');
      const [c, k, a, img, rw] = await Promise.all([api<ConfigStatus>('/api/config/status'), api<KeyUsageSummary[]>('/api/keys/usage'), api<Audit[]>('/api/audit'), api<ImageUsageSummary>('/api/images/usage'), api<ModelRewriteConfig>('/api/model-rewrite/config')]);
      setConfig(c);
      setKeys(k);
      setAudit(a);
      setImages(img);
      setRewriteConfig(rw);
      if (selected) setSelected(k.find(x => x.keyId === selected.keyId) ?? null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }

  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const totals = useMemo(() => keys.reduce((a, k) => ({ total: a.total + k.total, req: a.req + k.req, active: a.active + (k.isActive ? 1 : 0), attention: a.attention + (attention(k) ? 1 : 0), cost: a.cost + k.cost }), { total: 0, req: 0, active: 0, attention: 0, cost: 0 }), [keys]);
  const visible = keys.filter(k => filter === 'all' ? true : filter === 'attention' ? attention(k) : k.status === filter);

  async function savePolicy(k: KeyUsageSummary, form: HTMLFormElement) {
    const fd = new FormData(form);
    setSaving(k.keyId);
    try {
      await api(`/api/keys/${k.keyId}/policy`, { method: 'PATCH', body: JSON.stringify({ tokenLimit: fd.get('tokenLimit') ? Number(fd.get('tokenLimit')) : null, actionOnLimit: fd.get('actionOnLimit'), resetPolicy: fd.get('resetPolicy'), expiresAt: fromVnInput(fd.get('expiresAt')), usageMultiplier: fd.get('usageMultiplier') ? Number(fd.get('usageMultiplier')) : 1 }) });
      await refresh();
    } finally {
      setSaving('');
    }
  }

  async function quickDaily(k: KeyUsageSummary, limit: number) {
    await api(`/api/keys/${k.keyId}/policy`, { method: 'PATCH', body: JSON.stringify({ tokenLimit: limit, resetPolicy: 'daily', actionOnLimit: 'disable' }) });
    await refresh();
  }

  async function saveRewriteConfig(cfg: { enabled: boolean; rules: RewriteDraftRule[] }) {
    setSaving('model-rewrite');
    try {
      const next = await api<ModelRewriteConfig>('/api/model-rewrite/config', { method: 'PUT', body: JSON.stringify(cfg) });
      setRewriteConfig(next);
    } finally {
      setSaving('');
    }
  }

  async function resetWindow(k: KeyUsageSummary) {
    if (k.resetPolicy === 'daily' || k.resetPolicy === 'monthly') { setError(t.automaticWindow); return; }
    if (!confirm(`Reset usage window for ${k.name}?`)) return;
    await api(`/api/keys/${k.keyId}/reset-window`, { method: 'POST' });
    await refresh();
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  return <main><header><div><h1>{t.title}</h1><p>{t.subtitle}</p></div><div className="headActions"><select value={lang} onChange={e => setLang(e.target.value as Lang)}><option value="vi">VI</option><option value="en">EN</option></select><button onClick={refresh}>{t.refresh}</button><button type="button" onClick={logout}>{t.logout}</button></div></header>{error && <pre className="error">{error}</pre>}{config && !config.ok && <section className="setup"><h2>{t.setup}</h2>{config.errors.map(e => <p key={e}>{e}</p>)}</section>}<section className="cards"><div className="card primary"><span>{t.needs}</span><strong>{fmt(totals.attention)}</strong></div><div className="card"><span>{t.tokens}</span><strong>{fmt(totals.total)}</strong></div><div className="card"><span>{t.req}</span><strong>{fmt(totals.req)}</strong></div><div className="card"><span>{t.active}</span><strong>{fmt(totals.active)} / {fmt(keys.length)}</strong></div><div className="card"><span>{t.cost}</span><strong>${totals.cost.toFixed(4)}</strong></div><div className="card"><span>{t.auto}</span><strong>{config?.hardDisable ? 'ON' : 'DRY RUN'}</strong></div><div className="card"><span>{t.imagesToday}</span><strong>{fmt(images?.todayImages)}</strong></div><div className="card"><span>{t.imagesTotal}</span><strong>{fmt(images?.totalImages)}</strong></div></section><section className="flow"><b>{t.flow}</b><span>{t.f1}</span><span>{t.f2}</span><span>{t.f3}</span><span>{t.f4}</span></section><ModelRewritePanel config={rewriteConfig} onSave={saveRewriteConfig} saving={saving === 'model-rewrite'} /><section className="attention"><h2>{t.imageUsage}</h2><div className="stats"><label>{t.imagesToday}<b>{fmt(images?.todayImages)}</b></label><label>{t.imagesTotal}<b>{fmt(images?.totalImages)}</b></label><label>Success<b>{fmt(images?.success)}</b></label><label>Errors<b>{fmt(images?.errors)}</b></label><label>Bytes<b>{fmt(images?.bytes)}</b></label></div><h3>{t.recentImages}</h3><div className="audit">{images?.events?.length ? images.events.slice(0, 20).map(e => <div key={e.id}><code>{vnDateTime(e.created_at)} UTC+7</code> <b>{e.kind}</b> <span className={`pill ${e.status === 'success' ? 'ok' : 'danger'}`}>{e.status}</span> {e.model} {e.size} {e.output_file && <code>{e.output_file}</code>} {e.drive_path && <code>{e.drive_path}</code>} {e.error && <em>{e.error}</em>}</div>) : <p>{t.noAudit}</p>}</div></section><section className="attention"><h2>{t.needs}</h2>{keys.filter(attention).length === 0 ? <p>{t.healthy}</p> : keys.filter(attention).map(k => <button className={`issue ${k.status}`} key={k.keyId} onClick={() => setSelected(k)}><b>{k.name}</b><span>{k.statusReason}</span><em>{recommendation(k.status, k.actionOnLimit, config?.hardDisable, lang)}</em></button>)}</section><section className="toolbar">{(['attention', 'all', 'danger', 'warning', 'unlimited', 'expired', 'inactive', 'ok'] as Filter[]).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{filterLabel(f, lang)}</button>)}</section><section className="tableWrap"><table><thead><tr><th>{t.status}</th><th>{t.name}</th><th>{t.usage}</th><th>{t.tokens}</th><th>{t.daily}</th><th>{t.window}</th><th>{t.action}</th><th>{t.last}</th></tr></thead><tbody>{visible.map(k => <tr key={k.keyId} onClick={() => setSelected(k)}><td><span className={`pill ${k.status}`}>{statusLabel(k.status, lang)}</span></td><td><b>{k.name}</b><br /><code>{k.keyMasked}</code></td><td><div className="meter"><div style={{ width: `${Math.min(k.percentOfLimit ?? 0, 100)}%` }} /></div>{pct(k.percentOfLimit)}</td><td>{fmt(k.total)}</td><td>{fmt(k.tokenLimit)}</td><td>{k.resetPolicy}</td><td>{k.actionOnLimit}</td><td>{vnDateTime(k.lastUsageAt)}</td></tr>)}</tbody></table></section>{selected && <KeyDrawer selected={selected} audit={audit} config={config} lang={lang} saving={saving} onClose={() => setSelected(null)} onQuickDaily={quickDaily} onSavePolicy={savePolicy} onResetWindow={resetWindow} />}</main>;
}
