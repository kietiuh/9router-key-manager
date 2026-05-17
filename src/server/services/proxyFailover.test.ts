import { describe, expect, it, vi } from 'vitest';
import { fetchUpstreamWithFailover, isRetryableUpstreamStatus, ProxyFailoverError, TrafficAcquireError } from './proxyFailover.js';
import type { RewriteDecision } from './modelRewriteProxy.js';

function rewriteDecision(targets: string[]): RewriteDecision {
  const rawBody = Buffer.from('{"model":"source","stream":true}');
  return {
    rawBody,
    body: Buffer.from(JSON.stringify({ model: targets[0], stream: true })),
    parsedBody: { model: 'source', stream: true },
    rewritten: true,
    fromModel: 'source',
    toModel: targets[0],
    targets,
    model: targets[0],
  };
}

function passThroughDecision(): RewriteDecision {
  const rawBody = Buffer.from('{"model":"source","stream":true}');
  return {
    rawBody,
    body: rawBody,
    parsedBody: { model: 'source', stream: true },
    rewritten: false,
    targets: ['source'],
    model: 'source',
  };
}

function limiter() {
  const acquired: string[] = [];
  const released: string[] = [];
  return {
    acquired,
    released,
    trafficLimiter: {
      snapshot: () => [],
      acquire: async ({ model }: { model: string }) => {
        acquired.push(model);
        return { queuedMs: 0, timeoutMs: 1000, release: () => released.push(model) };
      },
    },
  };
}

describe('fetchUpstreamWithFailover', () => {
  it('classifies retryable upstream statuses', () => {
    expect(isRetryableUpstreamStatus(401)).toBe(true);
    expect(isRetryableUpstreamStatus(429)).toBe(true);
    expect(isRetryableUpstreamStatus(500)).toBe(true);
    expect(isRetryableUpstreamStatus(400)).toBe(false);
  });

  it('can proxy requests without a rewrite decision', async () => {
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/models',
      method: 'GET',
      headers: new Headers({ 'content-length': '99' }),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        expect(init?.body).toBeUndefined();
        expect((init?.headers as Headers).has('content-length')).toBe(false);
        return new Response('{}', { status: 200 });
      },
    });

    expect(limit.acquired).toEqual(['unknown']);
    expect(result.model).toBe('unknown');
    expect(result.bodyBytes).toBe(0);
    result.lease.release();
  });

  it('retries retryable upstream statuses with the next target model', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: calls.length === 1 ? 500 : 200 });
      },
    });

    expect(calls).toEqual(['v1', 'v2']);
    expect(limit.acquired).toEqual(['v1', 'v2']);
    expect(limit.released).toEqual(['v1']);
    expect(result.model).toBe('v2');
    expect(result.upstream.status).toBe(200);
    result.lease.release();
    expect(limit.released).toEqual(['v1', 'v2']);
  });

  it('does not retry non-retryable upstream statuses', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: 401 });
      },
    });

    expect(calls).toEqual(['v1', 'v2']);
    expect(limit.acquired).toEqual(['v1', 'v2']);
    expect(limit.released).toEqual(['v1']);
    expect(result.model).toBe('v2');
    expect(result.upstream.status).toBe(401);
    result.lease.release();
  });

  it('retries network errors with the next target model', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        if (calls.length === 1) throw new Error('socket closed');
        return new Response('{}', { status: 200 });
      },
    });

    expect(calls).toEqual(['v1', 'v2']);
    expect(limit.released).toEqual(['v1']);
    expect(result.model).toBe('v2');
    result.lease.release();
  });

  it('reports the rejected attempt index when traffic acquire fails', async () => {
    await expect(fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: {
        snapshot: () => [],
        acquire: async () => { throw new Error('queue full'); },
      },
    })).rejects.toMatchObject({
      attemptIndex: 0,
      model: 'v1',
    });

    await expect(fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: {
        snapshot: () => [],
        acquire: async () => { throw new Error('queue full'); },
      },
    })).rejects.toBeInstanceOf(TrafficAcquireError);
  });

  it('uses the final fallback model after rewrite targets fail with retryable statuses', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1', 'v2']),
      finalFallback: { enabled: true, model: 'stable' },
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: calls.length < 3 ? 500 : 200 });
      },
    });

    expect(calls).toEqual(['v1', 'v2', 'stable']);
    expect(limit.acquired).toEqual(['v1', 'v2', 'stable']);
    expect(limit.released).toEqual(['v1', 'v2']);
    expect(result.model).toBe('stable');
    expect(result.attemptCount).toBe(3);
    result.lease.release();
  });

  it('does not add final fallback when disabled', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1']),
      finalFallback: { enabled: false, model: 'stable' },
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: 500 });
      },
    });

    expect(calls).toEqual(['v1']);
    expect(result.model).toBe('v1');
    expect(result.upstream.status).toBe(500);
    result.lease.release();
  });

  it('uses final fallback for upstream 401', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1']),
      finalFallback: { enabled: true, model: 'stable' },
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: 401 });
      },
    });

    expect(calls).toEqual(['v1', 'stable']);
    expect(result.model).toBe('stable');
    expect(result.upstream.status).toBe(401);
    result.lease.release();
  });

  it('uses final fallback for pass-through JSON requests when the source model fails', async () => {
    const calls: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: passThroughDecision(),
      finalFallback: { enabled: true, model: 'stable' },
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response('{}', { status: calls.length === 1 ? 500 : 200 });
      },
    });

    expect(calls).toEqual(['source', 'stable']);
    expect(result.model).toBe('stable');
    expect(result.upstream.status).toBe(200);
    result.lease.release();
  });

  it('uses a generic retry log message for rewrite and final fallback retries', async () => {
    const messages: string[] = [];
    const limit = limiter();
    const result = await fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1']),
      finalFallback: { enabled: true, model: 'stable' },
      userId: 'user-1',
      largeContextThresholdTokens: 1000,
      trafficLimiter: limit.trafficLimiter,
      log: (_data, message) => messages.push(message),
      fetchImpl: async () => new Response('{}', { status: messages.length === 0 ? 500 : 200 }),
    });

    expect(messages).toEqual(['model failover retry']);
    result.lease.release();
  });

  it('maps final abort errors to upstream timeout', async () => {
    const limit = limiter();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    await expect(fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1']),
      userId: 'user-1',
      largeContextThresholdTokens: 1,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async () => { throw abortError; },
    })).rejects.toMatchObject({ statusCode: 504, type: 'upstream_timeout', model: 'v1' });

    await expect(fetchUpstreamWithFailover({
      upstreamUrl: 'http://upstream/v1/chat/completions',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      decision: rewriteDecision(['v1']),
      userId: 'user-1',
      largeContextThresholdTokens: 1,
      trafficLimiter: limit.trafficLimiter,
      fetchImpl: async () => { throw abortError; },
    })).rejects.toBeInstanceOf(ProxyFailoverError);
    expect(limit.released).toEqual(['v1', 'v1']);
  });

});
