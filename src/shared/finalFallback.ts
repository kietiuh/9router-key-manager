import type { FinalFallbackConfig } from './types.js';

export function normalizeFinalFallbackModels(cfg: Pick<FinalFallbackConfig, 'model'> & { models?: unknown }): string[] {
  const raw = [cfg.model, ...(Array.isArray(cfg.models) ? cfg.models : [])];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of raw) {
    const model = String(item ?? '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

export function normalizeFinalFallbackConfig(cfg: FinalFallbackConfig): FinalFallbackConfig {
  const models = normalizeFinalFallbackModels(cfg);
  return {
    enabled: Boolean(cfg.enabled),
    model: models[0] ?? '',
    models,
  };
}

export function finalFallbackNeedsModel(cfg: FinalFallbackConfig): boolean {
  return Boolean(cfg.enabled) && normalizeFinalFallbackConfig(cfg).models?.length === 0;
}
