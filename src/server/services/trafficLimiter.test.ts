import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTrafficLimitConfig, TrafficLimiter, type TrafficClass, type TrafficLimitConfig } from './trafficLimiter.js';

function config(overrides: Partial<TrafficLimitConfig> = {}): TrafficLimitConfig {
  return {
    enabled: true,
    globalMaxConcurrent: 5,
    perUserMaxConcurrent: 1,
    perUserQueueLimit: 1,
    largeContextThresholdTokens: 100000,
    largeContextMaxConcurrent: 1,
    largeContextQueueLimit: 1,
    modelLimits: { '*': { maxConcurrent: 5, queueLimit: 10, timeoutMs: 1000 } },
    ...overrides,
  };
}

const request: TrafficClass = {
  model: 'cx/gpt-5.5',
  userId: 'user-a',
  estimatedInputTokens: 1000,
  isLargeContext: false,
};

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function group(limiter: TrafficLimiter, name: string) {
  const row = limiter.snapshot().find(g => g.name === name);
  expect(row).toBeDefined();
  return row!;
}

describe('readTrafficLimitConfig', () => {
  it('parses env limits while preserving safe fallbacks', () => {
    const cfg = readTrafficLimitConfig({
      TRAFFIC_LIMIT_ENABLED: 'false',
      TRAFFIC_GLOBAL_MAX_CONCURRENT: '-1',
      TRAFFIC_PER_USER_MAX_CONCURRENT: '0',
      TRAFFIC_PER_USER_QUEUE_LIMIT: '7',
      TRAFFIC_LARGE_CONTEXT_TOKENS: 'not-a-number',
      TRAFFIC_MODEL_LIMITS: 'cx/gpt-5.5:3:30:9000,broken,cx/fallback:x:2:nope',
    });

    expect(cfg.enabled).toBe(false);
    expect(cfg.globalMaxConcurrent).toBe(20);
    expect(cfg.perUserMaxConcurrent).toBe(0);
    expect(cfg.perUserQueueLimit).toBe(7);
    expect(cfg.largeContextThresholdTokens).toBe(100000);
    expect(cfg.modelLimits['cx/gpt-5.5']).toEqual({ maxConcurrent: 3, queueLimit: 30, timeoutMs: 9000 });
    expect(cfg.modelLimits['cx/fallback']).toEqual({ maxConcurrent: 3, queueLimit: 2, timeoutMs: 120000 });
    expect(cfg.modelLimits.broken).toBeUndefined();
  });
});

describe('TrafficLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not allocate limiter groups when disabled', async () => {
    const limiter = new TrafficLimiter(config({
      enabled: false,
      modelLimits: { 'cx/gpt-5.5': { maxConcurrent: 0, queueLimit: 0, timeoutMs: 42 } },
    }));

    const lease = await limiter.acquire(request);

    expect(lease).toMatchObject({ queuedMs: 0, timeoutMs: 42 });
    lease.release();
    expect(limiter.snapshot()).toEqual([]);
  });

  it('queues same-user requests until the active lease is released', async () => {
    const limiter = new TrafficLimiter(config());
    const first = await limiter.acquire(request);
    let secondResolved = false;
    const secondPending = limiter.acquire(request).then(lease => {
      secondResolved = true;
      return lease;
    });

    await flushMicrotasks();

    expect(secondResolved).toBe(false);
    expect(group(limiter, 'user:user-a').queued).toBe(1);

    first.release();
    const second = await secondPending;

    expect(secondResolved).toBe(true);
    expect(group(limiter, 'user:user-a')).toMatchObject({ active: 1, queued: 0 });
    second.release();
    second.release();
    expect(group(limiter, 'user:user-a')).toMatchObject({ active: 0, queued: 0 });
  });

  it('rejects above the queue limit without leaking acquired groups', async () => {
    const limiter = new TrafficLimiter(config());
    const first = await limiter.acquire(request);
    const secondPending = limiter.acquire(request);

    await flushMicrotasks();

    await expect(limiter.acquire(request)).rejects.toThrow('traffic queue full: user:user-a');

    first.release();
    const second = await secondPending;
    second.release();

    expect(group(limiter, 'global').active).toBe(0);
    expect(group(limiter, 'model:cx/gpt-5.5').active).toBe(0);
    expect(group(limiter, 'user:user-a').active).toBe(0);
  });

  it('times out queued requests using the model timeout', async () => {
    vi.useFakeTimers();
    const limiter = new TrafficLimiter(config({
      modelLimits: { '*': { maxConcurrent: 5, queueLimit: 10, timeoutMs: 25 } },
    }));
    const first = await limiter.acquire(request);
    const secondPending = limiter.acquire(request);

    await flushMicrotasks();
    const rejection = expect(secondPending).rejects.toThrow('traffic queue timeout: user:user-a');
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    first.release();
    expect(group(limiter, 'user:user-a')).toMatchObject({ active: 0, queued: 0 });
  });

  it('applies the large-context group and timeout floor', async () => {
    const limiter = new TrafficLimiter(config({
      largeContextQueueLimit: 0,
      modelLimits: { 'cx/gpt-5.5': { maxConcurrent: 2, queueLimit: 1, timeoutMs: 1000 } },
    }));
    const largeRequest = { ...request, isLargeContext: true, estimatedInputTokens: 200000 };

    const lease = await limiter.acquire(largeRequest);

    expect(lease.timeoutMs).toBe(180000);
    expect(group(limiter, 'large-context')).toMatchObject({ active: 1, maxConcurrent: 1, queueLimit: 0 });
    await expect(limiter.acquire({ ...largeRequest, userId: 'user-b' })).rejects.toThrow('traffic queue full: large-context');

    lease.release();
    expect(group(limiter, 'large-context').active).toBe(0);
  });
});
