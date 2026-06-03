import { describe, expect, it } from 'vitest';
import { finalFallbackNeedsModel, normalizeFinalFallbackConfig } from './finalFallback.js';

describe('final fallback shared config helpers', () => {
  it('normalizes fallback model whitespace', () => {
    expect(normalizeFinalFallbackConfig({ enabled: true, model: ' stable/model ' })).toEqual({ enabled: true, model: 'stable/model', models: ['stable/model'] });
  });

  it('normalizes ordered fallback models with legacy model first', () => {
    expect(normalizeFinalFallbackConfig({ enabled: true, model: ' stable/a ', models: [' stable/a ', ' stable/b ', 'stable/a', '  '] })).toEqual({
      enabled: true,
      model: 'stable/a',
      models: ['stable/a', 'stable/b'],
    });
  });

  it('uses the first models entry when legacy model is empty', () => {
    expect(normalizeFinalFallbackConfig({ enabled: true, model: '', models: [' stable/b ', 'stable/c'] })).toEqual({
      enabled: true,
      model: 'stable/b',
      models: ['stable/b', 'stable/c'],
    });
  });

  it('requires a model only when final fallback is enabled', () => {
    expect(finalFallbackNeedsModel({ enabled: true, model: '   ', models: [] })).toBe(true);
    expect(finalFallbackNeedsModel({ enabled: true, model: '', models: ['stable/model'] })).toBe(false);
    expect(finalFallbackNeedsModel({ enabled: true, model: 'stable/model', models: [] })).toBe(false);
    expect(finalFallbackNeedsModel({ enabled: false, model: '', models: [] })).toBe(false);
  });
});
