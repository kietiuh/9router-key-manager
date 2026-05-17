import type { KeyUsageSummary } from '../shared/types';
import { fmt, pct, vnDateTime } from './format';
import { dict, filterLabel, statusLabel, type Filter, type Lang } from './i18n';
import { ADMIN_FILTERS, isKeyAttention } from './adminTabs';

export function AdminKeysSection({ filter, keys, lang, onFilter, onSelect }: { filter: Filter; keys: KeyUsageSummary[]; lang: Lang; onFilter: (filter: Filter) => void; onSelect: (key: KeyUsageSummary) => void }) {
  const t = dict[lang];
  const visible = keys.filter(k => filter === 'all' ? true : filter === 'attention' ? isKeyAttention(k) : k.status === filter);
  return <><section className="toolbar">{ADMIN_FILTERS.map(f => <button key={f} type="button" className={filter === f ? 'active' : ''} onClick={() => onFilter(f)}>{filterLabel(f, lang)}</button>)}</section><section className="tableWrap"><table><thead><tr><th>{t.status}</th><th>{t.name}</th><th>{t.usage}</th><th>{t.tokens}</th><th>Ảnh/ngày</th><th>{t.daily}</th><th>{t.window}</th><th>{t.action}</th><th>{t.last}</th></tr></thead><tbody>{visible.map(k => <tr key={k.keyId} onClick={() => onSelect(k)}><td><span className={`pill ${k.status}`}>{statusLabel(k.status, lang)}</span></td><td><b>{k.name}</b><br /><code>{k.keyMasked}</code></td><td><div className="meter"><div style={{ width: `${Math.min(k.percentOfLimit ?? 0, 100)}%` }} /></div>{pct(k.percentOfLimit)}</td><td>{fmt(k.total)}</td><td>{fmt((k.imageDailyUsed ?? 0))}/{k.imageDailyLimit ? fmt(k.imageDailyLimit) : "∞"}</td><td>{fmt(k.tokenLimit)}</td><td>{k.resetPolicy}</td><td>{k.actionOnLimit}</td><td>{vnDateTime(k.lastUsageAt)}</td></tr>)}</tbody></table></section></>;
}
