import { useEffect, useMemo, useState } from 'react';
import type { ConfigStatus, FinalFallbackConfig, ImageProxyConfig, ImageUsageSummary, KeyUsageSummary, ModelRewriteConfig } from '../shared/types';
import { api } from './api';
import { fromVnInput } from './format';
import { dict, type Filter, type Lang } from './i18n';
import { KeyDrawer } from './KeyDrawer';
import { AdminKeysSection } from './AdminKeys';
import { AttentionPanel, AdminSummaryCards, RecommendedFlow } from './AdminOverview';
import { ImageUsagePanel } from './AdminImages';
import { FinalFallbackPanel, ImageProxyPanel, ModelRewritePanel, type RewriteDraftGroup } from './AdminRouting';
import { AdminTabBar } from './AdminTabBar';
import type { Audit } from './adminTypes';
import { DEFAULT_ADMIN_TAB, getAdminTabCounts, isKeyAttention, type AdminTab } from './adminTabs';

export function Dashboard({ lang, setLang, onLogout }: { lang: Lang; setLang: (l: Lang) => void; onLogout: () => void }) {
  const t = dict[lang];
  const [keys, setKeys] = useState<KeyUsageSummary[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [rewriteConfig, setRewriteConfig] = useState<ModelRewriteConfig | null>(null);
  const [finalFallbackConfig, setFinalFallbackConfig] = useState<FinalFallbackConfig | null>(null);
  const [imageProxyConfig, setImageProxyConfig] = useState<ImageProxyConfig | null>(null);
  const [imageUsage, setImageUsage] = useState<ImageUsageSummary | null>(null);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [selected, setSelected] = useState<KeyUsageSummary | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');
  const [activeTab, setActiveTab] = useState<AdminTab>(DEFAULT_ADMIN_TAB);

  async function refresh() {
    try {
      setError('');
      const [c, k, a, rw, ff, ip, iu] = await Promise.all([api<ConfigStatus>('/api/config/status'), api<KeyUsageSummary[]>('/api/keys/usage'), api<Audit[]>('/api/audit'), api<ModelRewriteConfig>('/api/model-rewrite/config'), api<FinalFallbackConfig>('/api/final-fallback/config'), api<ImageProxyConfig>('/api/image-proxy/config'), api<ImageUsageSummary>('/api/images/usage')]);
      setConfig(c);
      setKeys(k);
      setAudit(a);
      setRewriteConfig(rw);
      setFinalFallbackConfig(ff);
      setImageProxyConfig(ip);
      setImageUsage(iu);
      if (selected) setSelected(k.find(x => x.keyId === selected.keyId) ?? null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }

  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const totals = useMemo(() => keys.reduce((a, k) => ({ total: a.total + k.total, req: a.req + k.req, active: a.active + (k.isActive ? 1 : 0), attention: a.attention + (isKeyAttention(k) ? 1 : 0), cost: a.cost + k.cost }), { total: 0, req: 0, active: 0, attention: 0, cost: 0 }), [keys]);
  const tabCounts = useMemo(() => getAdminTabCounts(keys, imageUsage), [keys, imageUsage]);

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

  async function saveFinalFallbackConfig(cfg: FinalFallbackConfig) {
    setSaving('final-fallback');
    try {
      const next = await api<FinalFallbackConfig>('/api/final-fallback/config', { method: 'PUT', body: JSON.stringify(cfg) });
      setFinalFallbackConfig(next);
    } finally {
      setSaving('');
    }
  }

  async function saveImageProxyConfig(cfg: ImageProxyConfig) {
    setSaving('image-proxy');
    try {
      const next = await api<ImageProxyConfig>('/api/image-proxy/config', { method: 'PUT', body: JSON.stringify(cfg) });
      setImageProxyConfig(next);
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

  return <main><header><div><h1>{t.title}</h1><p>{t.subtitle}</p></div><div className="headActions"><select value={lang} onChange={e => setLang(e.target.value as Lang)}><option value="vi">VI</option><option value="en">EN</option></select><button onClick={refresh}>{t.refresh}</button><button type="button" onClick={logout}>{t.logout}</button></div></header>{error && <pre className="error">{error}</pre>}{config && !config.ok && <section className="setup"><h2>{t.setup}</h2>{config.errors.map(e => <p key={e}>{e}</p>)}</section>}<section className="adminShell"><AdminTabBar active={activeTab} counts={tabCounts} lang={lang} onChange={setActiveTab} /><div className="adminTabPanel" role="tabpanel">{activeTab === 'overview' && <><AdminSummaryCards config={config} keys={keys} lang={lang} totals={totals} /><RecommendedFlow lang={lang} /><AttentionPanel config={config} keys={keys} lang={lang} onSelect={setSelected} /></>}{activeTab === 'keys' && <AdminKeysSection filter={filter} keys={keys} lang={lang} onFilter={setFilter} onSelect={setSelected} />}{activeTab === 'images' && <ImageUsagePanel usage={imageUsage} />}{activeTab === 'routing' && <><ModelRewritePanel config={rewriteConfig} onSave={saveRewriteConfig} saving={saving === 'model-rewrite'} /><FinalFallbackPanel config={finalFallbackConfig} onSave={saveFinalFallbackConfig} saving={saving === 'final-fallback'} /><ImageProxyPanel config={imageProxyConfig} onSave={saveImageProxyConfig} saving={saving === 'image-proxy'} /></>}</div></section>{selected && <KeyDrawer selected={selected} audit={audit} config={config} lang={lang} saving={saving} onClose={() => setSelected(null)} onQuickDaily={quickDaily} onSavePolicy={savePolicy} onResetWindow={resetWindow} />}</main>;
}
