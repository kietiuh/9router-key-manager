import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTrafficLimitConfig, TrafficLimiter } from './trafficLimiter.js';

describe('TrafficLimiter timeout policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses explicit upstream timeout overrides for normal and large-context requests', async () => {
    const limiter = new TrafficLimiter(readTrafficLimitConfig({
      TRAFFIC_MODEL_LIMITS: 'v1/cx/gpt-5.5:3:30:120000,*:20:100:120000',
      TRAFFIC_UPSTREAM_TIMEOUTS: 'v1/cx/gpt-5.5:300000:600000,*:120000:180000',
    } as NodeJS.ProcessEnv));

    const normalLease = await limiter.acquire({ model: 'v1/cx/gpt-5.5', userId: 'user-1', estimatedInputTokens: 50000, isLargeContext: false });
    const largeLease = await limiter.acquire({ model: 'v1/cx/gpt-5.5', userId: 'user-2', estimatedInputTokens: 250000, isLargeContext: true });

    expect(normalLease.timeoutMs).toBe(300000);
    expect(largeLease.timeoutMs).toBe(600000);

    largeLease.release();
    const fallbackLease = await limiter.acquire({ model: 'other-model', userId: 'user-3', estimatedInputTokens: 250000, isLargeContext: true });
    expect(fallbackLease.timeoutMs).toBe(180000);

    normalLease.release();
    fallbackLease.release();
  });

  it('uses queue timeout independently from upstream generation timeout', async () => {
    vi.useFakeTimers();
    const limiter = new TrafficLimiter(readTrafficLimitConfig({
      TRAFFIC_MODEL_LIMITS: 'slow-model:1:2:120000,*:20:100:120000',
      TRAFFIC_UPSTREAM_TIMEOUTS: 'slow-model:300000:600000,*:120000:180000',
      TRAFFIC_QUEUE_TIMEOUT_MS: '5',
    } as NodeJS.ProcessEnv));

    const firstLease = await limiter.acquire({ model: 'slow-model', userId: 'user-1', estimatedInputTokens: 1000, isLargeContext: false });
    let rejectedMessage: string | undefined;
    let secondRelease: (() => void) | undefined;
    const secondAcquire = limiter.acquire({ model: 'slow-model', userId: 'user-2', estimatedInputTokens: 1000, isLargeContext: false })
      .then(lease => {
        secondRelease = lease.release;
        return 'resolved';
      })
      .catch((err: Error) => {
        rejectedMessage = err.message;
        return 'rejected';
      });

    await vi.advanceTimersByTimeAsync(5);
    await Promise.resolve();
    const observed = rejectedMessage ?? 'pending';

    firstLease.release();
    await vi.advanceTimersByTimeAsync(0);
    await secondAcquire;
    secondRelease?.();

    expect(observed).toBe('traffic queue timeout: model:slow-model');
  });
});
