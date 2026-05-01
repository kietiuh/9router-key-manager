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
});
