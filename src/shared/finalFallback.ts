import type { FinalFallbackConfig } from './types.js';

export function normalizeFinalFallbackConfig(cfg: FinalFallbackConfig): FinalFallbackConfig {
  return {
    enabled: Boolean(cfg.enabled),
    model: String(cfg.model ?? '').trim(),
  };
}

export function finalFallbackNeedsModel(cfg: FinalFallbackConfig): boolean {
  return Boolean(cfg.enabled) && normalizeFinalFallbackConfig(cfg).model.length === 0;
}
