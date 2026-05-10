import { describe, expect, it } from 'vitest';
import { finalFallbackNeedsModel, normalizeFinalFallbackConfig } from './finalFallback.js';

describe('final fallback shared config helpers', () => {
  it('normalizes fallback model whitespace', () => {
    expect(normalizeFinalFallbackConfig({ enabled: true, model: ' stable/model ' })).toEqual({ enabled: true, model: 'stable/model' });
  });

  it('requires a model only when final fallback is enabled', () => {
    expect(finalFallbackNeedsModel({ enabled: true, model: '   ' })).toBe(true);
    expect(finalFallbackNeedsModel({ enabled: true, model: 'stable/model' })).toBe(false);
    expect(finalFallbackNeedsModel({ enabled: false, model: '' })).toBe(false);
  });
});
