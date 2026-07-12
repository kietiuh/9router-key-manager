import React from 'react';
import type { ConfigStatus, KeyUsageSummary } from '../shared/types';
import { fmt, fromVnInput, pct, toVnInput, vnDateTime } from './format';
import { dict, recommendation, statusLabel, type Lang } from './i18n';
import type { Audit } from './adminTypes';

export function KeyDrawer({ selected, audit, config, lang, saving, onClose, onQuickDaily, onSavePolicy, onResetWindow, onViewDetail }: { selected: KeyUsageSummary; audit: Audit[]; config: ConfigStatus | null; lang: Lang; saving: string; onClose: () => void; onQuickDaily: (k: KeyUsageSummary, limit: number) => void; onSavePolicy: (k: KeyUsageSummary, form: HTMLFormElement) => void; onResetWindow: (k: KeyUsageSummary) => void; onViewDetail: (k: KeyUsageSummary) => void }) {
  const t = dict[lang];
  const selectedAudit = audit.filter(a => a.key_id === selected.keyId);

  return <aside className="drawer">
    <button className="close" onClick={onClose}>×</button>    <h2>{selected.name}</h2>
    <p><code>{selected.keyMasked}</code> <span className={`pill ${selected.status}`}>{statusLabel(selected.status, lang)}</span> <button type="button" className="linkButton" onClick={() => onViewDetail(selected)}>{t.viewDetail}</button></p>
    <p className="reason"><b>{selected.statusReason}</b><br />{recommendation(selected.status, selected.actionOnLimit, config?.hardDisable, lang)}</p>
    <div className="quick">
      <button type="button" onClick={() => onQuickDaily(selected, Math.max(selected.total * 2, 1_000_000))}>{t.quick1}</button>
      <button type="button" onClick={() => onQuickDaily(selected, 50_000_000)}>{t.quick2}</button>
    </div>
    <form onSubmit={e => { e.preventDefault(); onSavePolicy(selected, e.currentTarget); }}>
      <label>{t.limit}<input name="tokenLimit" type="number" min="1" defaultValue={selected.tokenLimit ?? ''} /></label>
      <label>{t.reset}<select name="resetPolicy" defaultValue={selected.resetPolicy}><option value="daily">daily</option><option value="monthly">monthly</option><option value="manual">manual</option><option value="custom">custom</option></select></label>
      <label>{t.action}<select name="actionOnLimit" defaultValue={selected.actionOnLimit}><option value="disable">disable</option><option value="alert">alert</option><option value="none">none</option></select></label>
      <label>{t.multiplier}<input name="usageMultiplier" type="number" min="0" max="100" step="0.01" defaultValue={selected.usageMultiplier ?? 1} /></label>
      <label>{t.finalFallback}<input name="allowFinalFallback" type="checkbox" defaultChecked={selected.allowFinalFallback !== false} /></label>
      <label>{t.allowedModels}<textarea name="allowedModels" rows={3} placeholder={t.allowedModelsPlaceholder} defaultValue={(selected.allowedModels ?? []).join('\n')} /></label>
      <p className="hintText">{t.allowedModelsHint}</p>
      <label>{t.expires}<input name="expiresAt" type="datetime-local" defaultValue={toVnInput(selected.expiresAt)} /></label>
      <div className="actions"><button disabled={saving === selected.keyId}>{saving === selected.keyId ? t.saving : t.save}</button><button type="button" disabled={selected.resetPolicy === 'daily' || selected.resetPolicy === 'monthly'} onClick={() => onResetWindow(selected)}>{t.resetNow}</button></div>
    </form>
    <h3>{t.usageTitle}</h3>
    <div className="stats">
      <label>{t.total}<b>{fmt(selected.total)}</b></label>
      <label>{t.usage}<b>{pct(selected.percentOfLimit)}</b></label>
      <label>{t.prompt}<b>{fmt(selected.prompt)}</b></label>
      <label>{t.completion}<b>{fmt(selected.completion)}</b></label>
      <label>{t.cost}<b>${selected.cost.toFixed(6)}</b></label>
      <label>{t.last}<b>{vnDateTime(selected.lastUsageAt)}</b></label>
      <label>{t.multiplier}<b>{selected.usageMultiplier}×</b></label>
      <label>{t.actualTotal}<b>{fmt(selected.actualTotal)}</b></label>
      <label>{t.duplicates}<b>{fmt(selected.duplicateTokens)}</b></label>
    </div>
    <h3>{t.models}</h3>
    <pre>{JSON.stringify(selected.models, null, 2)}</pre>
    <h3>{t.audit}</h3>
    <div className="audit">{selectedAudit.length ? selectedAudit.map(a => <div key={a.id}><code>{vnDateTime(a.created_at)} UTC+7</code> <b>{a.action}</b> {a.message}</div>) : <p>{t.noAudit}</p>}</div>
  </aside>;
}

export { fromVnInput };
