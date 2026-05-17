import type { ConfigStatus, KeyUsageSummary } from '../shared/types';
import { fmt } from './format';
import { dict, recommendation, type Lang } from './i18n';
import { isKeyAttention } from './adminTabs';

type Totals = { total: number; req: number; active: number; attention: number; cost: number };

export function AdminSummaryCards({ config, keys, lang, totals }: { config: ConfigStatus | null; keys: KeyUsageSummary[]; lang: Lang; totals: Totals }) {
  const t = dict[lang];
  return <section className="cards"><div className="card primary"><span>{t.needs}</span><strong>{fmt(totals.attention)}</strong></div><div className="card"><span>{t.tokens}</span><strong>{fmt(totals.total)}</strong></div><div className="card"><span>{t.req}</span><strong>{fmt(totals.req)}</strong></div><div className="card"><span>{t.active}</span><strong>{fmt(totals.active)} / {fmt(keys.length)}</strong></div><div className="card"><span>{t.cost}</span><strong>${totals.cost.toFixed(4)}</strong></div><div className="card"><span>{t.auto}</span><strong>{config?.hardDisable ? 'ON' : 'DRY RUN'}</strong></div></section>;
}

export function RecommendedFlow({ lang }: { lang: Lang }) {
  const t = dict[lang];
  return <section className="flow"><b>{t.flow}</b><span>{t.f1}</span><span>{t.f2}</span><span>{t.f3}</span><span>{t.f4}</span></section>;
}

export function AttentionPanel({ config, keys, lang, onSelect }: { config: ConfigStatus | null; keys: KeyUsageSummary[]; lang: Lang; onSelect: (key: KeyUsageSummary) => void }) {
  const t = dict[lang];
  const attentionKeys = keys.filter(isKeyAttention);
  return <section className="attention"><h2>{t.needs}</h2>{attentionKeys.length === 0 ? <p>{t.healthy}</p> : attentionKeys.map(k => <button className={`issue ${k.status}`} key={k.keyId} onClick={() => onSelect(k)}><b>{k.name}</b><span>{k.statusReason}</span><em>{recommendation(k.status, k.actionOnLimit, config?.hardDisable, lang)}</em></button>)}</section>;
}
