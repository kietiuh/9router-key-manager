import type { AdminTab } from './adminTabs';
import { ADMIN_TAB_IDS, adminTabLabel } from './adminTabs';
import type { Lang } from './i18n';

export function AdminTabBar({ active, counts, lang, onChange }: { active: AdminTab; counts: Partial<Record<AdminTab, number>>; lang: Lang; onChange: (tab: AdminTab) => void }) {
  return <nav className="adminTabs" role="tablist" aria-label="Admin sections">{ADMIN_TAB_IDS.map(tab => <button key={tab} type="button" role="tab" aria-selected={active === tab} className={active === tab ? 'active' : ''} onClick={() => onChange(tab)}><span>{adminTabLabel(tab, lang)}</span>{counts[tab] !== undefined && <b>{counts[tab]}</b>}</button>)}</nav>;
}
