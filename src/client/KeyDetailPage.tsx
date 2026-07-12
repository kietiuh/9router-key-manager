import { useEffect, useState } from 'react';
import type { KeyUsageSummary } from '../shared/types';
import { api } from './api';
import { fmt, pct, vnDateTime } from './format';
import { dict, statusLabel, type Lang } from './i18n';
import { buildModelUsageRows, findKeyById } from './keyDetail';

export function KeyDetailPage({ keyId, lang, onBack }: { keyId: string; lang: Lang; onBack: () => void }) {
  const t = dict[lang];
  const [key, setKey] = useState<KeyUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<KeyUsageSummary[]>('/api/keys/usage')
      .then(keys => { if (alive) { setKey(findKeyById(keys, keyId)); setError(''); } })
      .catch((e: any) => { if (alive) setError(e.message ?? String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [keyId]);

  const rows = key ? buildModelUsageRows(key.modelUsage) : [];

  return <main>
    <header>
      <div><h1>{t.detailTitle}</h1>{key && <p><b>{key.name}</b> · <code>{key.keyMasked}</code></p>}</div>
      <div className="headActions"><button type="button" onClick={onBack}>← {t.back}</button></div>
    </header>
    {error && <pre className="error">{error}</pre>}
    {loading ? <p>{t.loading}</p> : !key ? <section className="card"><h2>{t.keyNotFound}</h2></section> : <>
      <p><span className={`pill ${key.status}`}>{statusLabel(key.status, lang)}</span> · {t.multiplier}: <b>{key.usageMultiplier}×</b></p>
      <section className="cards">
        <div className="card primary"><span>{t.total}</span><strong>{fmt(key.total)}</strong></div>
        <div className="card"><span>{t.prompt}</span><strong>{fmt(key.prompt)}</strong></div>
        <div className="card"><span>{t.completion}</span><strong>{fmt(key.completion)}</strong></div>
        <div className="card"><span>{t.req}</span><strong>{fmt(key.req)}</strong></div>
        <div className="card"><span>{t.cost}</span><strong>${key.cost.toFixed(6)}</strong></div>
        <div className="card"><span>{t.last}</span><strong>{vnDateTime(key.lastUsageAt)}</strong></div>
      </section>
      <h2>{t.models}</h2>
      {rows.length === 0 ? <p>{t.noModels}</p> : <section className="tableWrap"><table>
        <thead><tr><th>{t.modelName}</th><th>{t.req}</th><th>{t.inputTokens}</th><th>{t.outputTokens}</th><th>{t.totalTokens}</th><th>{t.share}</th><th>{t.last}</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.model}><td><code>{r.model}</code></td><td>{fmt(r.req)}</td><td>{fmt(r.prompt)}</td><td>{fmt(r.completion)}</td><td>{fmt(r.total)}</td><td><div className="meter"><div style={{ width: `${Math.min(r.percentOfTotal, 100)}%` }} /></div>{pct(r.percentOfTotal)}</td><td>{vnDateTime(r.lastUsageAt)}</td></tr>)}</tbody>
      </table></section>}
    </>}
  </main>;
}
