import { describe, expect, it } from 'vitest';
import { buildTrafficLogMeta } from './trafficLog.js';

const base = {
  model: 'cx/gpt-5.5',
  userId: 'u1',
  bodyBytes: 1024,
  estimatedInputTokens: 256,
  isLargeContext: false,
  queuedMs: 0,
  rateQueuedMs: 5000,
  rateLimitModel: 'v4/gpt-5.5',
  rateLimitRpm: 12,
  rateLimited: true,
  upstreamMs: 1200,
  upstreamTimeoutMs: 300000,
  totalMs: 1202,
  upstreamStatus: 200,
  attemptIndex: 0,
  attemptCount: 1,
  clientRateLimited: true,
  clientRateLimitRpm: 30,
  clientConcurrencyLimit: 5,
  clientRateRemaining: 12,
  clientActive: 3,
  limiter: [{ name: 'global', active: 1, queued: 0 }],
};

describe('trafficLog', () => {
  it('omits limiter snapshots from success logs by default', () => {
    expect(buildTrafficLogMeta(base)).not.toHaveProperty('limiter');
  });

  it('includes model rpm limiter metadata in success logs', () => {
    expect(buildTrafficLogMeta(base)).toMatchObject({
      rateQueuedMs: 5000,
      rateLimitModel: 'v4/gpt-5.5',
      rateLimitRpm: 12,
      rateLimited: true,
    });
  });

  it('includes API-key client limiter metadata in success logs', () => {
    expect(buildTrafficLogMeta(base)).toMatchObject({
      clientRateLimited: true,
      clientRateLimitRpm: 30,
      clientConcurrencyLimit: 5,
      clientRateRemaining: 12,
      clientActive: 3,
    });
  });

  it('includes limiter snapshots when enabled', () => {
    expect(buildTrafficLogMeta(base, { includeLimiter: true })).toMatchObject({
      model: 'cx/gpt-5.5',
      limiter: base.limiter,
    });
  });
});
