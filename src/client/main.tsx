import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConfigStatus, KeyStatus, KeyUsageSummary } from '../shared/types';
import './style.css';

type Audit = { id: number; key_id?: string; action: string; message: string; created_at: string };
type Filter = 'attention' | 'all' | KeyStatus;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
const fmt = (n?: number | null) => n == null ? '—' : n.toLocaleString();
const pct = (n?: number | null) => n == null ? '—' : `${n.toFixed(1)}%`;
function vnDateTime(utc?: string | null) { if (!utc) return '—'; return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(utc)); }
function toVnInput(utc?: string | null) { if (!utc) return ''; return new Date(new Date(utc).getTime() + 7*60*60*1000).toISOString().slice(0,16); }
function fromVnInput(v: FormDataEntryValue | null) { if (!v) return null; return new Date(new Date(`${v}:00.000Z`).getTime() - 7*60*60*1000).toISOString(); }
function attention(k: KeyUsageSummary) { return ['danger', 'expired', 'warning', 'unlimited'].includes(k.status); }
function recommendation(k: KeyUsageSummary, hardDisable?: boolean) {
  if (k.status === 'danger') return hardDisable && k.actionOnLimit === 'disable' ? 'Locked until next daily reset if watcher runs.' : 'Raise limit or set action to disable.';
  if (k.status === 'warning') return 'Watch usage; consider raising the daily limit.';
  if (k.status === 'unlimited') return 'Set a daily token limit to prevent runaway usage.';
  if (k.status === 'expired') return 'Extend expiry or replace this key.';
  if (k.status === 'inactive') return 'Inactive; no traffic should use this key.';
  return 'No action needed.';
}

function App() {
  const [keys, setKeys] = useState<KeyUsageSummary[]>([]), [audit, setAudit] = useState<Audit[]>([]), [config, setConfig] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState(''), [saving, setSaving] = useState(''), [selected, setSelected] = useState<KeyUsageSummary | null>(null), [filter, setFilter] = useState<Filter>('attention');
  async function refresh() { try { setError(''); const [c,k,a] = await Promise.all([api<ConfigStatus>('/api/config/status'), api<KeyUsageSummary[]>('/api/keys/usage'), api<Audit[]>('/api/audit')]); setConfig(c); setKeys(k); setAudit(a); if (selected) setSelected(k.find(x=>x.keyId===selected.keyId) ?? null); } catch(e:any){ setError(e.message ?? String(e)); } }
  useEffect(() => { refresh(); const id=setInterval(refresh, 15000); return()=>clearInterval(id); }, []);
  const totals = useMemo(() => keys.reduce((a,k)=>({ total:a.total+k.total, req:a.req+k.req, active:a.active+(k.isActive?1:0), attention:a.attention+(attention(k)?1:0), cost:a.cost+k.cost }), {total:0,req:0,active:0,attention:0,cost:0}), [keys]);
  const visible = keys.filter(k => filter==='all' ? true : filter==='attention' ? attention(k) : k.status===filter);
  const selectedAudit = selected ? audit.filter(a => a.key_id === selected.keyId) : [];
  async function savePolicy(k: KeyUsageSummary, form: HTMLFormElement) { const fd = new FormData(form); setSaving(k.keyId); try { await api(`/api/keys/${k.keyId}/policy`, { method:'PATCH', body: JSON.stringify({ tokenLimit: fd.get('tokenLimit') ? Number(fd.get('tokenLimit')) : null, actionOnLimit: fd.get('actionOnLimit'), resetPolicy: fd.get('resetPolicy'), expiresAt: fromVnInput(fd.get('expiresAt')) }) }); await refresh(); } finally { setSaving(''); } }
  async function quickDaily(k: KeyUsageSummary, limit: number) { await api(`/api/keys/${k.keyId}/policy`, { method:'PATCH', body: JSON.stringify({ tokenLimit: limit, resetPolicy:'daily', actionOnLimit:'disable' }) }); await refresh(); }
  async function resetWindow(k: KeyUsageSummary) { if (!confirm(`Reset usage window for ${k.name}? Historical usage stays intact.`)) return; await api(`/api/keys/${k.keyId}/reset-window`, { method:'POST' }); await refresh(); }

  return <main>
    <header><div><h1>9router Key Manager</h1><p>Daily token quota control. Set limit → watcher disables key when exceeded → daily reset can re-enable it.</p></div><button onClick={refresh}>Refresh</button></header>
    {error && <pre className="error">{error}</pre>}
    {config && !config.ok && <section className="setup"><h2>Setup needed</h2>{config.errors.map(e=><p key={e}>{e}</p>)}<small>NINE_ROUTER_DIR={config.nineRouterDir}</small></section>}
    <section className="cards"><div className="card primary"><span>Needs attention</span><strong>{fmt(totals.attention)}</strong></div><div className="card"><span>Today tokens</span><strong>{fmt(totals.total)}</strong></div><div className="card"><span>Requests</span><strong>{fmt(totals.req)}</strong></div><div className="card"><span>Active keys</span><strong>{fmt(totals.active)} / {fmt(keys.length)}</strong></div><div className="card"><span>Cost</span><strong>${totals.cost.toFixed(4)}</strong></div><div className="card"><span>Auto-disable</span><strong>{config?.hardDisable ? 'ON' : 'DRY RUN'}</strong></div></section>
    <section className="flow"><b>Recommended flow</b><span>1. Pick a key</span><span>2. Set Daily limit</span><span>3. Action = disable</span><span>4. Watcher locks it until next UTC+7 day</span></section>
    <section className="attention"><h2>Needs attention</h2>{keys.filter(attention).length===0 ? <p>Everything looks healthy.</p> : keys.filter(attention).map(k=><button className={`issue ${k.status}`} key={k.keyId} onClick={()=>setSelected(k)}><b>{k.name}</b><span>{k.statusReason}</span><em>{recommendation(k, config?.hardDisable)}</em></button>)}</section>
    <section className="toolbar">{(['attention','all','danger','warning','unlimited','expired','inactive','ok'] as Filter[]).map(f=><button key={f} className={filter===f?'active':''} onClick={()=>setFilter(f)}>{f}</button>)}</section>
    <section className="tableWrap"><table><thead><tr><th>Status</th><th>Name</th><th>Usage</th><th>Tokens</th><th>Daily limit</th><th>Window</th><th>Action</th><th>Last use</th></tr></thead><tbody>{visible.map(k=><tr key={k.keyId} onClick={()=>setSelected(k)}><td><span className={`pill ${k.status}`}>{k.status}</span></td><td><b>{k.name}</b><br/><code>{k.keyMasked}</code></td><td><div className="meter"><div style={{width:`${Math.min(k.percentOfLimit ?? 0,100)}%`}} /></div>{pct(k.percentOfLimit)}</td><td>{fmt(k.total)}</td><td>{fmt(k.tokenLimit)}</td><td>{k.resetPolicy}</td><td>{k.actionOnLimit}</td><td>{vnDateTime(k.lastUsageAt)}</td></tr>)}</tbody></table></section>
    {selected && <aside className="drawer"><button className="close" onClick={()=>setSelected(null)}>×</button><h2>{selected.name}</h2><p><code>{selected.keyMasked}</code> <span className={`pill ${selected.status}`}>{selected.status}</span></p><p className="reason"><b>{selected.statusReason}</b><br/>{recommendation(selected, config?.hardDisable)}</p>
      <div className="quick"><button type="button" onClick={()=>quickDaily(selected, Math.max(selected.total*2, 1_000_000))}>Quick: daily limit 2× current</button><button type="button" onClick={()=>quickDaily(selected, 50_000_000)}>50M/day + disable</button></div>
      <form onSubmit={e=>{e.preventDefault(); savePolicy(selected, e.currentTarget);}}><label>Daily/token limit<input name="tokenLimit" type="number" min="1" defaultValue={selected.tokenLimit ?? ''} placeholder="No limit" /></label><label>Reset policy<select name="resetPolicy" defaultValue={selected.resetPolicy}><option value="daily">daily</option><option value="monthly">monthly</option><option value="manual">manual</option><option value="custom">custom</option></select></label><label>Action on limit<select name="actionOnLimit" defaultValue={selected.actionOnLimit}><option value="disable">disable</option><option value="alert">alert</option><option value="none">none</option></select></label><label>Expires at UTC+7<input name="expiresAt" type="datetime-local" defaultValue={toVnInput(selected.expiresAt)} /></label><div className="actions"><button disabled={saving===selected.keyId}>{saving===selected.keyId?'Saving…':'Save policy'}</button><button type="button" onClick={()=>resetWindow(selected)}>Reset window now</button></div></form>
      <h3>Usage</h3><div className="stats"><label>Total <b>{fmt(selected.total)}</b></label><label>Usage <b>{pct(selected.percentOfLimit)}</b></label><label>Prompt <b>{fmt(selected.prompt)}</b></label><label>Completion <b>{fmt(selected.completion)}</b></label><label>Cost <b>${selected.cost.toFixed(6)}</b></label><label>Last use <b>{vnDateTime(selected.lastUsageAt)}</b></label></div><h3>Models</h3><pre>{JSON.stringify(selected.models,null,2)}</pre><h3>Audit</h3><div className="audit">{selectedAudit.length ? selectedAudit.map(a=><div key={a.id}><code>{a.created_at}</code> <b>{a.action}</b> {a.message}</div>) : <p>No audit events.</p>}</div></aside>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
