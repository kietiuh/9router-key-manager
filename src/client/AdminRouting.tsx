import { useEffect, useState } from 'react';
import type { FinalFallbackConfig, ImageProxyConfig, ModelRewriteConfig } from '../shared/types';
import { finalFallbackNeedsModel } from '../shared/finalFallback';
import { IMAGE_PROXY_ALLOWED_BASE_URLS } from '../shared/imageProxy';

type RewriteDraftRule = { id?: number; groupId?: number | null; enabled: boolean; fromModel: string; toModel: string; toModels: string[]; stickyCount: number; targetWeights: number[] };
export type RewriteDraftGroup = { id?: number; name: string; enabled: boolean; rules: RewriteDraftRule[] };

function positiveInt(value: unknown, fallback = 1): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function draftWeights(weights: unknown, targetCount: number, fallback: number): number[] {
  const raw = Array.isArray(weights) ? weights : [];
  return Array.from({ length: targetCount }, (_, index) => positiveInt(raw[index], fallback));
}

function draftRule(r: ModelRewriteConfig['groups'][number]['rules'][number]): RewriteDraftRule {
  const targets = r.toModels?.length ? r.toModels : (r.toModel ? [r.toModel] : ['']);
  const stickyCount = positiveInt(r.stickyCount ?? 1);
  const targetWeights = draftWeights(r.targetWeights, targets.length, stickyCount);
  return { id: r.id, groupId: r.groupId, enabled: r.enabled, fromModel: r.fromModel, toModel: targets[0] ?? '', toModels: targets, stickyCount: targetWeights[0] ?? stickyCount, targetWeights };
}

function draftGroups(config: ModelRewriteConfig | null): RewriteDraftGroup[] {
  if (config?.groups?.length) return config.groups.map(g => ({ id: g.id, name: g.name, enabled: g.enabled, rules: g.rules.map(draftRule) }));
  if (config?.rules?.length) return [{ name: 'Default', enabled: true, rules: config.rules.map(draftRule) }];
  return [];
}

export function ModelRewritePanel({ config, onSave, saving }: { config: ModelRewriteConfig | null; onSave: (cfg: { enabled: boolean; groups: RewriteDraftGroup[] }) => Promise<void>; saving: boolean }) {
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
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: [...g.rules, { enabled: true, fromModel: '', toModel: '', toModels: [''], stickyCount: 1, targetWeights: [1] }] } : g));
  };
  const patchRule = (groupIdx: number, ruleIdx: number, patch: Partial<RewriteDraftRule>) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => j === ruleIdx ? { ...r, ...patch } : r) } : g));
  };
  const patchTarget = (groupIdx: number, ruleIdx: number, targetIdx: number, value: string) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => {
      if (j !== ruleIdx) return r;
      const toModels = r.toModels.map((target, k) => k === targetIdx ? value : target);
      return { ...r, toModels, toModel: toModels[0] ?? '' };
    }) } : g));
  };
  const patchTargetWeight = (groupIdx: number, ruleIdx: number, targetIdx: number, value: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => {
      if (j !== ruleIdx) return r;
      const targetWeights = r.targetWeights.map((weight, k) => k === targetIdx ? positiveInt(value, weight) : weight);
      return { ...r, targetWeights, stickyCount: targetWeights[0] ?? 1 };
    }) } : g));
  };
  const addTarget = (groupIdx: number, ruleIdx: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => j === ruleIdx ? { ...r, toModels: [...r.toModels, ''], targetWeights: [...r.targetWeights, 1] } : r) } : g));
  };
  const removeTarget = (groupIdx: number, ruleIdx: number, targetIdx: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.map((r, j) => {
      if (j !== ruleIdx) return r;
      const toModels = r.toModels.filter((_, k) => k !== targetIdx);
      const targetWeights = r.targetWeights.filter((_, k) => k !== targetIdx);
      const next = toModels.length ? toModels : [''];
      const nextWeights = targetWeights.length ? targetWeights : [1];
      return { ...r, toModels: next, toModel: next[0] ?? '', targetWeights: nextWeights, stickyCount: nextWeights[0] ?? 1 };
    }) } : g));
  };
  const removeRule = (groupIdx: number, ruleIdx: number) => {
    setDirty(true);
    setGroups(groups.map((g, i) => i === groupIdx ? { ...g, rules: g.rules.filter((_, j) => j !== ruleIdx) } : g));
  };
  const save = async () => {
    const payload = groups.map(g => ({ ...g, rules: g.rules.map(r => {
      const pairs = (r.toModels.length ? r.toModels : [r.toModel])
        .map((v, index) => ({ model: v.trim(), weight: positiveInt(r.targetWeights[index], 1) }))
        .filter(pair => pair.model);
      const toModels = pairs.map(pair => pair.model);
      const targetWeights = pairs.map(pair => pair.weight);
      return { ...r, toModels, toModel: toModels[0] ?? '', stickyCount: targetWeights[0] ?? 1, targetWeights };
    }) }));
    await onSave({ enabled, groups: payload });
    setDirty(false);
  };
  return (
    <section className="attention">
      <h2>Cấu hình nâng cao — Model rewrite</h2>
      <p>Soft OFF: tắt global là proxy không rewrite model. Khi bật, hệ thống duyệt group theo thứ tự, rule khớp đầu tiên sẽ đổi A → B:1, C:2, D:3 theo số lượt từng target và failover.</p>
      <label><input type="checkbox" checked={enabled} onChange={e => markEnabled(e.target.checked)} /> Enable model rewrite</label>
      <div className="rewriteList">
        {groups.map((g, groupIdx) => (
          <div className="rewriteGroup" key={groupIdx}>
            <div className="rewriteGroupHead">
              <label><input type="checkbox" checked={g.enabled} onChange={e => patchGroup(groupIdx, { enabled: e.target.checked })} /> Group enabled</label>
              <label>Group name<input value={g.name} onChange={e => patchGroup(groupIdx, { name: e.target.value })} placeholder="Group A" /></label>
              <button type="button" onClick={() => removeGroup(groupIdx)}>Remove group</button>
            </div>
            <div className="rewriteRules">
              {g.rules.map((r, ruleIdx) => (
                <div className="rewriteRule" key={ruleIdx}>
                  <label><input type="checkbox" checked={r.enabled} onChange={e => patchRule(groupIdx, ruleIdx, { enabled: e.target.checked })} /> Rule enabled</label>
                  <label>From model<input value={r.fromModel} onChange={e => patchRule(groupIdx, ruleIdx, { fromModel: e.target.value })} placeholder="cx/gpt-5.5" /></label>
                  <div className="rewriteTargets">
                    <span>Target models</span>
                    {r.toModels.map((target, targetIdx) => (
                      <div className="rewriteTarget" key={targetIdx}>
                        <input value={target} onChange={e => patchTarget(groupIdx, ruleIdx, targetIdx, e.target.value)} placeholder={`v${targetIdx + 1}/cx/gpt-5.5`} />
                        <label>Lượt<input type="number" min={1} value={r.targetWeights[targetIdx] ?? 1} onChange={e => patchTargetWeight(groupIdx, ruleIdx, targetIdx, Number(e.target.value))} /></label>
                        <button type="button" onClick={() => removeTarget(groupIdx, ruleIdx, targetIdx)}>Remove target</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => addTarget(groupIdx, ruleIdx)}>Add target</button>
                  </div>
                  <button type="button" onClick={() => removeRule(groupIdx, ruleIdx)}>Remove rule</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => addRule(groupIdx)}>Add rule</button>
          </div>
        ))}
      </div>
      <div className="actions">
        <button type="button" onClick={addGroup}>Add group</button>
        <button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save rewrite config'}{dirty ? ' *' : ''}</button>
      </div>
    </section>
  );
}

export function FinalFallbackPanel({ config, onSave, saving }: { config: FinalFallbackConfig | null; onSave: (cfg: FinalFallbackConfig) => Promise<void>; saving: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [models, setModels] = useState<string[]>(['']);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setEnabled(Boolean(config?.enabled));
    setModels(config?.models?.length ? config.models : [config?.model ?? '']);
  }, [config, dirty]);
  const patchModel = (idx: number, value: string) => {
    setDirty(true);
    setModels(models.map((model, i) => i === idx ? value : model));
  };
  const addModel = () => {
    setDirty(true);
    setModels([...models, '']);
  };
  const removeModel = (idx: number) => {
    setDirty(true);
    const next = models.filter((_, i) => i !== idx);
    setModels(next.length ? next : ['']);
  };
  const moveModel = (idx: number, direction: -1 | 1) => {
    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= models.length) return;
    setDirty(true);
    const next = [...models];
    [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
    setModels(next);
  };
  const cleanModels = models.map(model => model.trim()).filter(Boolean);
  const missingModel = finalFallbackNeedsModel({ enabled, model: cleanModels[0] ?? '', models: cleanModels });
  const save = async () => {
    if (missingModel) return;
    await onSave({ enabled, model: cleanModels[0] ?? '', models: cleanModels });
    setDirty(false);
  };
  return <section className="attention fallbackPanel"><h2>Cấu hình ngoài cùng — Final fallback</h2><div className="fallbackFields"><label><input type="checkbox" checked={enabled} onChange={e => { setDirty(true); setEnabled(e.target.checked); }} /> Enable final fallback</label><div className="fallbackModels"><span>Fallback models</span>{models.map((model, idx) => <div className="fallbackModelRow" key={idx}><input value={model} onChange={e => patchModel(idx, e.target.value)} placeholder={idx === 0 ? 'stable/a' : 'stable/b'} /><button type="button" onClick={() => moveModel(idx, -1)} disabled={idx === 0}>Up</button><button type="button" onClick={() => moveModel(idx, 1)} disabled={idx === models.length - 1}>Down</button><button type="button" onClick={() => removeModel(idx)}>Remove</button></div>)}<button type="button" onClick={addModel}>Add model</button></div></div>{missingModel && <p className="formError">At least one fallback model is required when enabled.</p>}<div className="actions"><button onClick={save} disabled={saving || missingModel}>{saving ? 'Saving...' : 'Save final fallback'}{dirty ? ' *' : ''}</button></div></section>;
}

export function ImageProxyPanel({ config, onSave, saving }: { config: ImageProxyConfig | null; onSave: (cfg: ImageProxyConfig) => Promise<void>; saving: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [upstreamBaseUrl, setUpstreamBaseUrl] = useState('https://shopapikey.com/v1');
  const [authMode, setAuthMode] = useState<ImageProxyConfig['authMode']>('pass-through');
  const [modelOverride, setModelOverride] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (dirty) return; setEnabled(Boolean(config?.enabled)); setUpstreamBaseUrl(config?.upstreamBaseUrl ?? 'https://shopapikey.com/v1'); setAuthMode(config?.authMode ?? 'pass-through'); setModelOverride(config?.modelOverride ?? ''); }, [config, dirty]);
  const save = async () => {
    await onSave({ enabled, upstreamBaseUrl, authMode, modelOverride: modelOverride.trim() });
    setDirty(false);
  };
  return <section className="attention fallbackPanel"><h2>Image proxy routing</h2><p>Route /v1/images/generations and /v1/images/edits directly to selected image upstream. Chat/text requests stay on 9router.</p><div className="fallbackFields"><label><input type="checkbox" checked={enabled} onChange={e => { setDirty(true); setEnabled(e.target.checked); }} /> Enable image direct proxy</label><label>Upstream<select value={upstreamBaseUrl} onChange={e => { setDirty(true); setUpstreamBaseUrl(e.target.value); }}>{IMAGE_PROXY_ALLOWED_BASE_URLS.map(url => <option key={url} value={url}>{url}</option>)}</select></label><label>Auth mode<select value={authMode} onChange={e => { setDirty(true); setAuthMode(e.target.value as ImageProxyConfig['authMode']); }}><option value="pass-through">Pass through client Authorization</option><option value="server-key">Server key override (IMAGE_PROXY_API_KEY)</option></select></label><label>Model override (optional)<input value={modelOverride} onChange={e => { setDirty(true); setModelOverride(e.target.value); }} placeholder="cx/gpt-5.4-image" /></label></div><div className="actions"><button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save image proxy'}{dirty ? ' *' : ''}</button></div></section>;
}
