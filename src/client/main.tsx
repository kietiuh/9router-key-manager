import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { KeyUsageSummary } from '../shared/types';
import './style.css';

type Audit = { id: number; key_id?: string; action: string; message: string; created_at: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmt(n?: number | null) { return n == null ? '—' : n.toLocaleString(); }
function pct(n?: number | null) { return n == null ? '—' : `${n.toFixed(2)}%`; }
function vnDateTime(utc?: string | null) {
  if (!utc) return '—';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(new Date(utc));
}
function toVnInput(utc?: string | null) {
  if (!utc) return '';
  const d = new Date(new Date(utc).getTime() + 7*60*60*1000);
  return d.toISOString().slice(0,16);
}
function fromVnInput(v: FormDataEntryValue | null) {
  if (!v) return null;
  return new Date(new Date(`${v}:00.000Z`).getTime() - 7*60*60*1000).toISOString();
}

function App() {
  const [keys, setKeys] = useState<KeyUsageSummary[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState<string>('');
  const [saving, setSaving] = useState<string>('');

  async function refresh() {
    try {
      setError('');
      const [k, a] = await Promise.all([api<KeyUsageSummary[]>('/api/keys/usage'), api<Audit[]>('/api/audit')]);
      setKeys(k); setAudit(a);
    } catch (e: any) { setError(e.message ?? String(e)); }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const totals = useMemo(() => keys.reduce((acc, k) => ({ total: acc.total + k.total, req: acc.req + k.req }), { total: 0, req: 0 }), [keys]);

  async function savePolicy(k: KeyUsageSummary, form: HTMLFormElement) {
    const fd = new FormData(form);
    setSaving(k.keyId);
    try {
      await api(`/api/keys/${k.keyId}/policy`, { method: 'PATCH', body: JSON.stringify({
        tokenLimit: fd.get('tokenLimit') ? Number(fd.get('tokenLimit')) : null,
        actionOnLimit: fd.get('actionOnLimit'),
        expiresAt: fromVnInput(fd.get('expiresAt')),
      }) });
      await refresh();
    } finally { setSaving(''); }
  }

  async function resetWindow(k: KeyUsageSummary) {
    if (!confirm(`Reset usage window for ${k.name}? Historical usage stays intact.`)) return;
    await api(`/api/keys/${k.keyId}/reset-window`, { method: 'POST' });
    await refresh();
  }

  return <main>
    <header>
      <div><h1>9router Key Manager</h1><p>Local quota/expiry dashboard. UI timezone: UTC+7. Daily quota resets 00:00 UTC+7.</p></div>
      <button onClick={refresh}>Refresh</button>
    </header>
    {error && <pre className="error">{error}</pre>}
    <section className="cards">
      <div className="card"><span>Total tokens</span><strong>{fmt(totals.total)}</strong></div>
      <div className="card"><span>Requests</span><strong>{fmt(totals.req)}</strong></div>
      <div className="card"><span>Keys</span><strong>{keys.length}</strong></div>
    </section>
    <section className="grid">
      {keys.map(k => <form key={k.keyId} className="key" onSubmit={e => { e.preventDefault(); savePolicy(k, e.currentTarget); }}>
        <div className="key-head"><div><h2>{k.name}</h2><code>{k.keyMasked}</code></div><span className={k.isActive ? 'ok' : 'off'}>{k.isActive ? 'active' : 'inactive'}</span></div>
        <div className="meter"><div style={{ width: `${Math.min(k.percentOfLimit ?? 0, 100)}%` }} /></div>
        <div className="stats">
          <label>Today total <b>{fmt(k.total)}</b></label><label>Daily quota <b>{pct(k.percentOfLimit)}</b></label>
          <label>Prompt <b>{fmt(k.prompt)}</b></label><label>Completion <b>{fmt(k.completion)}</b></label>
          <label>Req <b>{fmt(k.req)}</b></label><label>Cost <b>${k.cost.toFixed(6)}</b></label>
        </div>
        <div className="fields">
          <label>Token limit<input name="tokenLimit" type="number" min="1" defaultValue={k.tokenLimit ?? ''} placeholder="e.g. 100000000" /></label>
          <label>Action<select name="actionOnLimit" defaultValue={k.actionOnLimit}><option value="alert">alert</option><option value="disable">disable</option><option value="none">none</option></select></label>
          <label>Daily window <b>{vnDateTime(k.windowStart)} → {vnDateTime(k.windowEnd)}</b></label>
          <label>Expires at (UTC+7)<input name="expiresAt" type="datetime-local" defaultValue={toVnInput(k.expiresAt)} /></label>
        </div>
        <details><summary>Models</summary><pre>{JSON.stringify(k.models, null, 2)}</pre></details>
        <div className="actions"><button disabled={saving===k.keyId}>{saving===k.keyId ? 'Saving…' : 'Save policy'}</button><button type="button" onClick={() => resetWindow(k)}>Reset today window</button></div>
      </form>)}
    </section>
    <section><h2>Audit log</h2><div className="audit">{audit.map(a => <div key={a.id}><code>{a.created_at}</code> <b>{a.action}</b> {a.message}</div>)}</div></section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
