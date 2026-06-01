import { describe, expect, it } from 'vitest';
import { readUpstreamTimeoutConfig, timeoutForModel } from './upstreamTimeouts.js';

describe('upstream timeout policy', () => {
  it('uses explicit upstream timeout overrides for normal and large-context requests', () => {
    const cfg = readUpstreamTimeoutConfig({
      TRAFFIC_MODEL_LIMITS: 'v1/cx/gpt-5.5:3:30:120000,*:20:100:120000',
      TRAFFIC_UPSTREAM_TIMEOUTS: 'v1/cx/gpt-5.5:300000:600000,*:120000:180000',
      TRAFFIC_LARGE_CONTEXT_TOKENS: '250000',
    } as NodeJS.ProcessEnv);

    expect(cfg.largeContextThresholdTokens).toBe(250000);
    expect(timeoutForModel(cfg, 'v1/cx/gpt-5.5', false)).toBe(300000);
    expect(timeoutForModel(cfg, 'v1/cx/gpt-5.5', true)).toBe(600000);
    expect(timeoutForModel(cfg, 'other-model', false)).toBe(120000);
    expect(timeoutForModel(cfg, 'other-model', true)).toBe(180000);
  });

  it('keeps legacy model timeout fallback without enabling concurrency limits', () => {
    const cfg = readUpstreamTimeoutConfig({
      TRAFFIC_MODEL_LIMITS: 'slow-model:1:2:240000,*:20:100:120000',
    } as NodeJS.ProcessEnv);

    expect(timeoutForModel(cfg, 'slow-model', false)).toBe(240000);
    expect(timeoutForModel(cfg, 'slow-model', true)).toBe(240000);
    expect(timeoutForModel(cfg, 'other-model', false)).toBe(120000);
  });
});
