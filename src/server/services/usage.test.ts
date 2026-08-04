import { describe, expect, it } from 'vitest';
import { summarizeKeyUsage } from './usage.js';

const keys = [
  { id: 'a', name: 'Key A', key: 'sk-aaaaaaaaaaaaaaaa', isActive: true },
  { id: 'b', name: 'Key B', key: 'sk-bbbbbbbbbbbbbbbb', isActive: true }
];

const usage = [
  { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-01T00:00:00.000Z', tokens: { prompt_tokens: 10, completion_tokens: 5 }, cost: 0.1 },
  { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { total_tokens: 50, prompt_tokens: 40, completion_tokens: 10 }, cost: 0.2 },
  { apiKey: 'sk-bbbbbbbbbbbbbbbb', model: 'm2', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 7, completion_tokens: 3 }, cost: 0.3 }
];

describe('summarizeKeyUsage', () => {
  it('sums only records inside usage window per key', () => {
    const out = summarizeKeyUsage(keys, usage, [{ key_id: 'a', window_start: '2026-05-01T12:00:00.000Z', token_limit: 100, action_on_limit: 'alert' }]);
    expect(out.find(x => x.keyId === 'a')?.total).toBe(50);
    expect(out.find(x => x.keyId === 'a')?.percentOfLimit).toBe(50);
    expect(out.find(x => x.keyId === 'b')?.total).toBe(10);
  });

  it('reports final fallback policy with default allow behavior', () => {
    const out = summarizeKeyUsage(keys, [], [
      { key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', allow_final_fallback: 0 },
      { key_id: 'b', window_start: '2026-05-01T00:00:00.000Z' },
    ]);

    expect(out.find(x => x.keyId === 'a')?.allowFinalFallback).toBe(false);
    expect(out.find(x => x.keyId === 'b')?.allowFinalFallback).toBe(true);
  });

  it('dedupes 9router double-written records before summing', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', provider: 'p', connectionId: 'c', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 80 }, cost: 0.1 } as any,
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', provider: 'p', connectionId: 'c', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20 }, cost: 0.2 } as any
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z' }])[0];
    expect(out.total).toBe(120);
    expect(out.duplicateRequests).toBe(1);
    expect(out.duplicateTokens).toBe(120);
  });

  it('dedupes rows when total tokens are implied by prompt and completion', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', provider: 'p', connectionId: 'c', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, cost: 0.1 } as any,
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', provider: 'p', connectionId: 'c', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20 }, cost: 0.2 } as any
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z' }])[0];
    expect(out.total).toBe(120);
    expect(out.duplicateRequests).toBe(1);
    expect(out.duplicateTokens).toBe(120);
  });

  it('applies multiplier only from the effective timestamp to prompt and completion', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20 }, cost: 0.1 },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-03T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20 }, cost: 0.1 }
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', usage_multiplier: 1.5, usage_multiplier_effective_at: '2026-05-03T00:00:00.000Z' }])[0];
    expect(out.actualTotal).toBe(240);
    expect(out.prompt).toBe(250);
    expect(out.completion).toBe(50);
    expect(out.total).toBe(300);
  });

  it('preserves historical multiplier segments after later multiplier changes', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-01T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 0 }, cost: 0.1 },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 0 }, cost: 0.1 },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-03T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 0 }, cost: 0.1 },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-04T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 0 }, cost: 0.1 }
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', usage_multiplier: 1, usage_multiplier_effective_at: '2026-05-04T00:00:00.000Z', usage_multiplier_events: [
      { multiplier: 2, effective_at: '2026-05-02T00:00:00.000Z' },
      { multiplier: 3, effective_at: '2026-05-03T00:00:00.000Z' },
      { multiplier: 1, effective_at: '2026-05-04T00:00:00.000Z' }
    ] }])[0];
    expect(out.actualTotal).toBe(400);
    expect(out.total).toBe(700);
    expect(out.percentOfLimit).toBeNull();
  });

  it('scales cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens by multiplier', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 40, reasoning_tokens: 12 }, cost: 0.1 },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-03T00:00:00.000Z', tokens: { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 40, reasoning_tokens: 12 }, cost: 0.1 }
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', usage_multiplier: 1.5, usage_multiplier_effective_at: '2026-05-03T00:00:00.000Z' }])[0];
    // Row 1 is before effective_at -> factor 1; Row 2 is after -> factor 1.5
    expect(out.actualCacheRead).toBe(160);
    expect(out.actualCacheCreation).toBe(80);
    expect(out.actualReasoning).toBe(24);
    expect(out.cacheRead).toBe(80 + Math.round(80 * 1.5));
    expect(out.cacheCreation).toBe(40 + Math.round(40 * 1.5));
    expect(out.reasoning).toBe(12 + Math.round(12 * 1.5));
  });

  it('treats cache and reasoning fields as zero when missing on a record', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm1', timestamp: '2026-05-02T00:00:00.000Z', tokens: { prompt_tokens: 10, completion_tokens: 5 } }
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', usage_multiplier: 2, usage_multiplier_effective_at: '2026-05-01T00:00:00.000Z' }])[0];
    expect(out.actualCacheRead).toBe(0);
    expect(out.actualCacheCreation).toBe(0);
    expect(out.actualReasoning).toBe(0);
    expect(out.cacheRead).toBe(0);
    expect(out.cacheCreation).toBe(0);
    expect(out.reasoning).toBe(0);
  });

  it('exposes allowedModels parsed from the policy column', () => {
    const keys = [{ id: 'k1', name: 'K1', key: 'sk-1', isActive: true }];
    const policies = [{ key_id: 'k1', window_start: '1970-01-01T00:00:00.000Z', allowed_models_json: JSON.stringify(['claude-opus-4.8', '', 'claude-opus-4.8']) }];
    const summary = summarizeKeyUsage(keys, [], policies).at(0)!;
    expect(summary.allowedModels).toEqual(['claude-opus-4.8']);
  });

  it('returns an empty allowedModels list when the column is null', () => {
    const keys = [{ id: 'k1', name: 'K1', key: 'sk-1', isActive: true }];
    const policies = [{ key_id: 'k1', window_start: '1970-01-01T00:00:00.000Z', allowed_models_json: null }];
    const summary = summarizeKeyUsage(keys, [], policies).at(0)!;
    expect(summary.allowedModels).toEqual([]);
  });
});
