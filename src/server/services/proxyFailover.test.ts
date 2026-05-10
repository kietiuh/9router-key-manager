import { describe, expect, it } from 'vitest';
import { fetchUpstreamWithFailover, TrafficAcquireError } from './proxyFailover.js';
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

    expect(calls).toEqual(['v1']);
    expect(limit.acquired).toEqual(['v1']);
    expect(result.model).toBe('v1');
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
});
