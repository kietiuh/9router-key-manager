import { describe, expect, it } from 'vitest';
import { defaultWindowStart, summarizeKeyUsage } from './usage.js';

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

  it('excludes records at window_end and includes records at window_start', () => {
    const rows = [
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 10 } },
      { apiKey: 'sk-aaaaaaaaaaaaaaaa', model: 'm', timestamp: '2026-05-02T00:00:00.000Z', tokens: { total_tokens: 90 } }
    ];
    const out = summarizeKeyUsage([keys[0]], rows, [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', window_end: '2026-05-02T00:00:00.000Z' }])[0];
    expect(out.total).toBe(10);
  });

  it('pins exact status thresholds and inactive precedence', () => {
    const warning = summarizeKeyUsage([keys[0]], [{ apiKey: keys[0].key, timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 80 } }], [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', token_limit: 100 }])[0];
    expect(warning.status).toBe('warning');
    const danger = summarizeKeyUsage([keys[0]], [{ apiKey: keys[0].key, timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 100 } }], [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', token_limit: 100 }])[0];
    expect(danger.status).toBe('danger');
    const inactive = summarizeKeyUsage([{ ...keys[0], isActive: false }], [{ apiKey: keys[0].key, timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 100 } }], [{ key_id: 'a', window_start: '2026-05-01T00:00:00.000Z', token_limit: 100, expires_at: '2026-01-01T00:00:00.000Z' }], '2026-05-01T00:00:00.000Z')[0];
    expect(inactive.status).toBe('inactive');
  });

  it('returns the provided default window start', () => {
    expect(defaultWindowStart('2026-05-05T00:00:00.000Z')).toBe('2026-05-05T00:00:00.000Z');
  });
});
