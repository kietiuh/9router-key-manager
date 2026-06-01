import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRateLimiter } from './modelRateLimiter.js';

const baseRule = {
  model: 'v4/gpt-5.5',
  enabled: true,
  rpm: 12,
  queueLimit: 10,
  maxQueueWaitMs: 60_000,
};

describe('ModelRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spaces matching model requests evenly by rpm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ModelRateLimiter({ enabled: true, rules: [baseRule] });

    const first = await limiter.acquire('v4/gpt-5.5');
    const secondAcquire = limiter.acquire('v4/gpt-5.5');
    let secondResolved = false;
    secondAcquire.then(() => { secondResolved = true; });

    expect(first).toMatchObject({ rateLimited: true, rateLimitModel: 'v4/gpt-5.5', rateLimitRpm: 12, rateQueuedMs: 0 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(secondResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const second = await secondAcquire;

    expect(secondResolved).toBe(true);
    expect(second).toMatchObject({ rateLimited: true, rateLimitModel: 'v4/gpt-5.5', rateLimitRpm: 12, rateQueuedMs: 5_000 });
  });

  it('lets unconfigured models pass immediately', async () => {
    const limiter = new ModelRateLimiter({ enabled: true, rules: [baseRule] });

    await expect(limiter.acquire('other-model')).resolves.toMatchObject({
      rateLimited: false,
      rateLimitModel: 'other-model',
      rateLimitRpm: null,
      rateQueuedMs: 0,
    });
  });

  it('rejects matching requests when the model queue is full', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ModelRateLimiter({ enabled: true, rules: [{ ...baseRule, queueLimit: 1 }] });

    await limiter.acquire('v4/gpt-5.5');
    const queued = limiter.acquire('v4/gpt-5.5');

    await expect(limiter.acquire('v4/gpt-5.5')).rejects.toThrow('model rate queue full: v4/gpt-5.5');

    await vi.advanceTimersByTimeAsync(5_000);
    await queued;
  });

  it('rejects matching requests when the reserved slot exceeds max queue wait', async () => {
    const limiter = new ModelRateLimiter({ enabled: true, rules: [{ ...baseRule, rpm: 1, maxQueueWaitMs: 1_000 }] });

    await limiter.acquire('v4/gpt-5.5');

    await expect(limiter.acquire('v4/gpt-5.5')).rejects.toThrow('model rate queue timeout: v4/gpt-5.5');
  });

  it('releases queued requests when config is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ModelRateLimiter({ enabled: true, rules: [baseRule] });

    await limiter.acquire('v4/gpt-5.5');
    const queued = limiter.acquire('v4/gpt-5.5');
    let resolved = false;
    queued.then(() => { resolved = true; });

    limiter.updateConfig({ enabled: false, rules: [] });
    await Promise.resolve();
    const lease = await queued;

    expect(resolved).toBe(true);
    expect(lease).toMatchObject({ rateLimited: false, rateLimitModel: 'v4/gpt-5.5', rateQueuedMs: 0 });
  });
});
