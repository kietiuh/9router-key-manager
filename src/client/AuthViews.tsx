import React, { useState } from 'react';
import type { KeyUsageSummary } from '../shared/types';
import { api } from './api';
import { fmt, pct, vnDateTime } from './format';
import { dict, type Lang, statusLabel } from './i18n';

export function PublicCheck({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = dict[lang];
  const [key, setKey] = useState('');
  const [result, setResult] = useState<KeyUsageSummary | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setResult(null);
    setLoading(true);
    try {
      setResult(await api<KeyUsageSummary>('/api/public/key-check', { method: 'POST', body: JSON.stringify({ key }) }));
    } catch {
      setErr(t.notFound);
    } finally {
      setLoading(false);
    }
  }

  return <main className="login"><form className="loginBox publicBox" onSubmit={submit}><h1>{t.publicCheck}</h1><label>{t.lang}<select value={lang} onChange={e => setLang(e.target.value as Lang)}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label><label>{t.keyInput}<input value={key} onChange={e => setKey(e.target.value)} autoFocus /></label>{err && <p className="loginErr">{err}</p>}<button disabled={loading}>{loading ? '…' : t.check}</button>{result && <div className="publicResult"><p><b>{result.name}</b> <span className={`pill ${result.status}`}>{statusLabel(result.status, lang)}</span></p><p>{result.keyMasked}</p><div className="stats"><label>{t.tokens}<b>{fmt(result.total)}</b></label><label>{t.usage}<b>{pct(result.percentOfLimit)}</b></label><label>{t.daily}<b>{fmt(result.tokenLimit)}</b></label><label>{t.last}<b>{vnDateTime(result.lastUsageAt)}</b></label><label>{t.action}<b>{result.actionOnLimit}</b></label><label>{t.window}<b>{result.resetPolicy}</b></label></div></div>}</form></main>;
}

export function Login({ lang, setLang, onOk }: { lang: Lang; setLang: (l: Lang) => void; onOk: () => void }) {
  const t = dict[lang];
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pass }) });
      onOk();
    } catch {
      setErr(t.wrong);
    }
  }

  return <main className="login"><form className="loginBox" onSubmit={submit}><h1>{t.loginTitle}</h1><label>{t.lang}<select value={lang} onChange={e => setLang(e.target.value as Lang)}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></label><label>{t.password}<input type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)} /></label>{err && <p className="loginErr">{err}</p>}<button>{t.unlock}</button></form></main>;
}
