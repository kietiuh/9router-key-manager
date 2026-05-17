import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTrafficLimitConfig, TrafficLimiter, type TrafficClass, type TrafficLimitConfig } from './trafficLimiter.js';

const baseConfig: TrafficLimitConfig = {
  enabled: true,
  globalMaxConcurrent: 1,
  perUserMaxConcurrent: 2,
  perUserQueueLimit: 1,
  largeContextThresholdTokens: 100000,
  largeContextMaxConcurrent: 1,
  largeContextQueueLimit: 1,
  modelLimits: { '*': { maxConcurrent: 2, queueLimit: 1, timeoutMs: 120000 } },
};

const trafficClass: TrafficClass = {
  model: 'gpt',
  userId: 'user-a',
  estimatedInputTokens: 100,
  isLargeContext: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('readTrafficLimitConfig', () => {
  it('parses env config with safe fallbacks', () => {
    const cfg = readTrafficLimitConfig({
      TRAFFIC_LIMIT_ENABLED: 'false',
      TRAFFIC_GLOBAL_MAX_CONCURRENT: 'not-a-number',
      TRAFFIC_PER_USER_MAX_CONCURRENT: '3',
      TRAFFIC_MODEL_LIMITS: 'gpt:1:2:3000,broken,*:4:5:6000',
    } as NodeJS.ProcessEnv);

    expect(cfg.enabled).toBe(false);
    expect(cfg.globalMaxConcurrent).toBe(20);
    expect(cfg.perUserMaxConcurrent).toBe(3);
    expect(cfg.modelLimits).toEqual({
      gpt: { maxConcurrent: 1, queueLimit: 2, timeoutMs: 3000 },
      '*': { maxConcurrent: 4, queueLimit: 5, timeoutMs: 6000 },
    });
  });
});

describe('TrafficLimiter', () => {
  it('returns an immediate no-op lease when disabled', async () => {
    const limiter = new TrafficLimiter({ ...baseConfig, enabled: false, modelLimits: { '*': { maxConcurrent: 2, queueLimit: 2, timeoutMs: 5000 } } });

    await expect(limiter.acquire(trafficClass)).resolves.toMatchObject({ queuedMs: 0, timeoutMs: 5000 });
    expect(limiter.snapshot()).toEqual([]);
  });

  it('queues over global concurrency and releases exactly once', async () => {
    const limiter = new TrafficLimiter(baseConfig);
    const first = await limiter.acquire(trafficClass);
    const secondPromise = limiter.acquire({ ...trafficClass, userId: 'user-b' });
    await Promise.resolve();

    expect(limiter.snapshot().find(group => group.name === 'global')).toMatchObject({ active: 1, queued: 1 });

    first.release();
    const second = await secondPromise;
    second.release();
    second.release();

    expect(limiter.snapshot().find(group => group.name === 'global')).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases already acquired groups when a later group rejects', async () => {
    const limiter = new TrafficLimiter({
      ...baseConfig,
      globalMaxConcurrent: 5,
      modelLimits: { '*': { maxConcurrent: 1, queueLimit: 0, timeoutMs: 120000 } },
    });
    const first = await limiter.acquire(trafficClass);

    await expect(limiter.acquire({ ...trafficClass, userId: 'user-b' })).rejects.toThrow('traffic queue full: model:gpt');
    expect(limiter.snapshot().find(group => group.name === 'global')).toMatchObject({ active: 1, queued: 0 });

    first.release();
  });

  it('adds the large-context group and extends timeout for large requests', async () => {
    const limiter = new TrafficLimiter(baseConfig);
    const lease = await limiter.acquire({ ...trafficClass, isLargeContext: true });

    expect(lease.timeoutMs).toBe(180000);
    expect(limiter.snapshot().find(group => group.name === 'large-context')).toMatchObject({ active: 1, queued: 0 });

    lease.release();
  });

  it('times out queued requests', async () => {
    vi.useFakeTimers();
    const limiter = new TrafficLimiter(baseConfig);
    const first = await limiter.acquire(trafficClass);
    const secondPromise = limiter.acquire({ ...trafficClass, userId: 'user-b' });
    await Promise.resolve();

    const rejection = expect(secondPromise).rejects.toThrow('traffic queue timeout: global');
    await vi.advanceTimersByTimeAsync(120000);
    await rejection;

    first.release();
    expect(limiter.snapshot().find(group => group.name === 'global')).toMatchObject({ active: 0, queued: 0 });
  });
});
