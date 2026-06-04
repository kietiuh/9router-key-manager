import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientRateLimitAcquireError, ClientRateLimiter, buildClientRateLimitErrorBody } from './clientRateLimiter.js';

const baseConfig = {
  enabled: true,
  rpm: 2,
  concurrency: 10,
};

describe('ClientRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an API key after its RPM window is exhausted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ClientRateLimiter(baseConfig);

    const first = limiter.acquire('key-1');
    const second = limiter.acquire('key-1');

    expect(first).toMatchObject({
      clientLimited: true,
      keyId: 'key-1',
      clientRateLimitRpm: 2,
      clientConcurrencyLimit: 10,
      clientRateRemaining: 1,
    });
    expect(second).toMatchObject({
      clientLimited: true,
      keyId: 'key-1',
      clientRateRemaining: 0,
    });
    expect(() => limiter.acquire('key-1')).toThrow(ClientRateLimitAcquireError);
    try {
      limiter.acquire('key-1');
    } catch (err) {
      expect(err).toMatchObject({
        type: 'client_rpm_exceeded',
        keyId: 'key-1',
        statusCode: 429,
        retryAfter: 60,
      });
    }

    vi.setSystemTime(60_000);
    expect(limiter.acquire('key-1')).toMatchObject({ clientRateRemaining: 1 });
    first.release();
    second.release();
  });

  it('limits concurrency per API key and releases the slot when the lease is released', () => {
    const limiter = new ClientRateLimiter({ enabled: true, rpm: 30, concurrency: 1 });
    const lease = limiter.acquire('key-2');

    expect(() => limiter.acquire('key-2')).toThrow(ClientRateLimitAcquireError);
    try {
      limiter.acquire('key-2');
    } catch (err) {
      expect(err).toMatchObject({
        type: 'client_concurrency_exceeded',
        keyId: 'key-2',
        statusCode: 429,
        retryAfter: 1,
      });
    }

    lease.release();
    expect(limiter.acquire('key-2')).toMatchObject({ clientActive: 1 });
  });

  it('tracks each API key independently', () => {
    const limiter = new ClientRateLimiter({ enabled: true, rpm: 1, concurrency: 1 });

    limiter.acquire('key-a');

    expect(limiter.acquire('key-b')).toMatchObject({
      keyId: 'key-b',
      clientRateRemaining: 0,
      clientActive: 1,
    });
  });

  it('passes through when the limiter is disabled', () => {
    const limiter = new ClientRateLimiter({ enabled: false, rpm: 1, concurrency: 1 });

    expect(limiter.acquire('key-3')).toMatchObject({
      clientLimited: false,
      keyId: 'key-3',
      clientRateLimitRpm: null,
      clientConcurrencyLimit: null,
      clientRateRemaining: null,
      clientActive: 0,
    });
  });

  it('prunes expired idle API-key states', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ClientRateLimiter({ enabled: true, rpm: 1, concurrency: 1 });
    const lease = limiter.acquire('old-key');
    lease.release();

    vi.setSystemTime(60_000);
    limiter.acquire('new-key');

    expect(limiter.snapshot().map(s => s.keyId)).toEqual(['new-key']);
  });

  it('builds OpenAI-compatible 429 error bodies', () => {
    const err = new ClientRateLimitAcquireError(
      'API key RPM limit exceeded',
      'client_rpm_exceeded',
      'key-4',
      [],
      23,
      '2026-06-04T00:01:00.000Z',
    );

    expect(buildClientRateLimitErrorBody(err)).toEqual({
      error: {
        message: 'API key RPM limit exceeded',
        type: 'rate_limit_exceeded',
        code: 'client_rpm_exceeded',
        retry_after: 23,
        reset_at: '2026-06-04T00:01:00.000Z',
      },
    });
  });
});
