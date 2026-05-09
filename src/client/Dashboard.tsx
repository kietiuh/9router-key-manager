import React, { useEffect, useMemo, useState } from 'react';
import type { ConfigStatus, KeyUsageSummary, ModelRewriteConfig } from '../shared/types';
import { api } from './api';
import { fmt, fromVnInput, pct, vnDateTime } from './format';
import { dict, filterLabel, recommendation, statusLabel, type Filter, type Lang } from './i18n';
import { KeyDrawer } from './KeyDrawer';

type Audit = { id: number; key_id?: string; action: string; message: string; created_at: string };

type RewriteDraftRule = { id?: number; groupId?: number | null; enabled: boolean; fromModel: string; toModel: string; note?: string | null };
type RewriteDraftGroup = { id?: number; name: string; enabled: boolean; rules: RewriteDraftRule[] };

function draftGroups(config: ModelRewriteConfig | null): RewriteDraftGroup[] {
  if (config?.groups?.length) return config.groups.map(g => ({ id: g.id, name: g.name, enabled: g.enabled, rules: g.rules.map(r => ({ id: r.id, groupId: r.groupId, enabled: r.enabled, fromModel: r.fromModel, toModel: r.toModel, note: r.note })) }));
  if (config?.rules?.length) return [{ name: 'Default', enabled: true, rules: config.rules.map(r => ({ id: r.id, groupId: r.groupId, enabled: r.enabled, fromModel: r.fromModel, toModel: r.toModel, note: r.note })) }];
  return [];
}

function ModelRewritePanel({ config, onSave, saving }: { config: ModelRewriteConfig | null; onSave: (cfg: { enabled: boolean; groups: RewriteDraftGroup[] }) => Promise<void>; saving: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [groups, setGroups] = useState<RewriteDraftGroup[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (dirty) return; setEnabled(Boolean(config?.enabled)); setGroups(draftGroups(config)); }, [config, dirty]);
  const markEnabled = (v: boolean) => { setDirty(true); setEnabled(v); };
  const addGroup = () => { setDirty(true); setGroups([...groups, { name: `Group ${groups.length + 1}`, enabled: true, rules: [] }]); };
  const patchGroup = (idx: number, patch: Partial<RewriteDraftGroup>) => { setDirty(true); setGroups(groups.map((g, i) => i === idx ? { ...g, ...patch } : g)); };
  const removeGroup = (idx: number) => { setDirty(true); setGroups(groups.filter((_, i) => i !== idx)); };
  const addRule = (groupIdx: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: [...g.rules, { enabled: true, fromModel: '', toModel: '', note: '' }] } : g));
  };
  const patchRule = (groupIdx: number, ruleIdx: number, patch: Partial<RewriteDraftRule>) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => j === ruleIdx ? { ...r, ...patch } : r) } : g));
  };
  const removeRule = (groupIdx: number, ruleIdx: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.filter((_, j) => j !== ruleIdx) } : g));
  };
  const save = async () => { await onSave({ enabled, groups }); setDirty(false); };
  return <section className="attention"><h2>Cấu hình nâng cao — Model rewrite</h2><p>Soft OFF: tắt global là proxy không rewrite model. Khi bật, hệ thống duyệt group theo thứ tự, bỏ qua group/rule đang tắt, rule khớp đầu tiên sẽ đổi A → B.</p><label><input type="checkbox" checked={enabled} onChange={e => markEnabled(e.target.checked)} /> Enable model rewrite</label><div className="rewriteList">{groups.map((g, groupIdx) => <div className="rewriteGroup" key={groupIdx}><div className="rewriteGroupHead"><label><input type="checkbox" checked={g.enabled} onChange={e => patchGroup(groupIdx, { enabled: e.target.checked })} /> Group enabled</label><label>Group name<input value={g.name} onChange={e => patchGroup(groupIdx, { name: e.target.value })} placeholder="Group A" /></label><button type="button" onClick={() => removeGroup(groupIdx)}>Remove group</button></div><div className="rewriteRules">{g.rules.map((r, ruleIdx) => <div className="rewriteRule" key={ruleIdx}><label><input type="checkbox" checked={r.enabled} onChange={e => patchRule(groupIdx, ruleIdx, { enabled: e.target.checked })} /> Rule enabled</label><label>From model<input value={r.fromModel} onChange={e => patchRule(groupIdx, ruleIdx, { fromModel: e.target.value })} placeholder="v1/cx/gpt-5.5" /></label><label>To model<input value={r.toModel} onChange={e => patchRule(groupIdx, ruleIdx, { toModel: e.target.value })} placeholder="cx/gpt-5.5" /></label><label>Note<input value={r.note ?? ''} onChange={e => patchRule(groupIdx, ruleIdx, { note: e.target.value })} placeholder="optional" /></label><button type="button" onClick={() => removeRule(groupIdx, ruleIdx)}>Remove</button></div>)}</div><button type="button" onClick={() => addRule(groupIdx)}>Add rule</button></div>)}</div><div className="actions"><button type="button" onClick={addGroup}>Add group</button><button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save rewrite config'}{dirty ? ' *' : ''}</button></div></section>;
}

function attention(k: KeyUsageSummary) {
  return ['danger', 'expired', 'warning', 'unlimited'].includes(k.status);
}

export function Dashboard({ lang, setLang, onLogout }: { lang: Lang; setLang: (l: Lang) => void; onLogout: () => void }) {
  const t = dict[lang];
  const [keys, setKeys] = useState<KeyUsageSummary[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [rewriteConfig, setRewriteConfig] = useState<ModelRewriteConfig | null>(null);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [selected, setSelected] = useState<KeyUsageSummary | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');

  async function refresh() {
    try {
      setError('');
      const [c, k, a, rw] = await Promise.all([api<ConfigStatus>('/api/config/status'), api<KeyUsageSummary[]>('/api/keys/usage'), api<Audit[]>('/api/audit'), api<ModelRewriteConfig>('/api/model-rewrite/config')]);
      setConfig(c);
      setKeys(k);
      setAudit(a);
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

  async function saveRewriteConfig(cfg: { enabled: boolean; groups: RewriteDraftGroup[] }) {
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

  return <main><header><div><h1>{t.title}</h1><p>{t.subtitle}</p></div><div className="headActions"><select value={lang} onChange={e => setLang(e.target.value as Lang)}><option value="vi">VI</option><option value="en">EN</option></select><button onClick={refresh}>{t.refresh}</button><button type="button" onClick={logout}>{t.logout}</button></div></header>{error && <pre className="error">{error}</pre>}{config && !config.ok && <section className="setup"><h2>{t.setup}</h2>{config.errors.map(e => <p key={e}>{e}</p>)}</section>}<section className="cards"><div className="card primary"><span>{t.needs}</span><strong>{fmt(totals.attention)}</strong></div><div className="card"><span>{t.tokens}</span><strong>{fmt(totals.total)}</strong></div><div className="card"><span>{t.req}</span><strong>{fmt(totals.req)}</strong></div><div className="card"><span>{t.active}</span><strong>{fmt(totals.active)} / {fmt(keys.length)}</strong></div><div className="card"><span>{t.cost}</span><strong>${totals.cost.toFixed(4)}</strong></div><div className="card"><span>{t.auto}</span><strong>{config?.hardDisable ? 'ON' : 'DRY RUN'}</strong></div></section><section className="flow"><b>{t.flow}</b><span>{t.f1}</span><span>{t.f2}</span><span>{t.f3}</span><span>{t.f4}</span></section><section className="attention"><h2>{t.needs}</h2>{keys.filter(attention).length === 0 ? <p>{t.healthy}</p> : keys.filter(attention).map(k => <button className={`issue ${k.status}`} key={k.keyId} onClick={() => setSelected(k)}><b>{k.name}</b><span>{k.statusReason}</span><em>{recommendation(k.status, k.actionOnLimit, config?.hardDisable, lang)}</em></button>)}</section><section className="toolbar">{(['attention', 'all', 'danger', 'warning', 'unlimited', 'expired', 'inactive', 'ok'] as Filter[]).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{filterLabel(f, lang)}</button>)}</section><section className="tableWrap"><table><thead><tr><th>{t.status}</th><th>{t.name}</th><th>{t.usage}</th><th>{t.tokens}</th><th>{t.daily}</th><th>{t.window}</th><th>{t.action}</th><th>{t.last}</th></tr></thead><tbody>{visible.map(k => <tr key={k.keyId} onClick={() => setSelected(k)}><td><span className={`pill ${k.status}`}>{statusLabel(k.status, lang)}</span></td><td><b>{k.name}</b><br /><code>{k.keyMasked}</code></td><td><div className="meter"><div style={{ width: `${Math.min(k.percentOfLimit ?? 0, 100)}%` }} /></div>{pct(k.percentOfLimit)}</td><td>{fmt(k.total)}</td><td>{fmt(k.tokenLimit)}</td><td>{k.resetPolicy}</td><td>{k.actionOnLimit}</td><td>{vnDateTime(k.lastUsageAt)}</td></tr>)}</tbody></table></section><ModelRewritePanel config={rewriteConfig} onSave={saveRewriteConfig} saving={saving === 'model-rewrite'} />{selected && <KeyDrawer selected={selected} audit={audit} config={config} lang={lang} saving={saving} onClose={() => setSelected(null)} onQuickDaily={quickDaily} onSavePolicy={savePolicy} onResetWindow={resetWindow} />}</main>;
}
