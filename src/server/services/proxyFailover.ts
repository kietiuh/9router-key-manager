import { buildRewriteBody, type RewriteDecision } from './modelRewriteProxy.js';
import type { TrafficClass, TrafficLease } from './trafficLimiter.js';

export type TrafficLimiterLike = {
  acquire: (cls: TrafficClass) => Promise<TrafficLease>;
  snapshot: () => unknown;
};

export type FetchUpstreamResult = {
  upstream: Response;
  lease: TrafficLease;
  model: string;
  body?: Buffer;
  bodyBytes: number;
  estimatedInputTokens: number;
  isLargeContext: boolean;
  queuedMs: number;
  upstreamMs: number;
  attemptIndex: number;
  attemptCount: number;
};

export class TrafficAcquireError extends Error {
  statusCode = 429;
  retryAfter = 10;
  type = 'queue_full';
  constructor(message: string, public readonly cause: unknown, public readonly snapshot: unknown, public readonly model: string) {
    super(message);
  }
}

export class ProxyFailoverError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly type: string, public readonly cause: unknown, public readonly model: string) {
    super(message);
  }
}

type FetchImpl = (input: string, init?: RequestInit & { duplex?: 'half' }) => Promise<Response>;

export type FetchUpstreamOptions = {
  upstreamUrl: string;
  method: string;
  headers: Headers;
  decision?: RewriteDecision;
  userId: string;
  largeContextThresholdTokens: number;
  trafficLimiter: TrafficLimiterLike;
  fetchImpl?: FetchImpl;
  log?: (data: Record<string, unknown>, message: string) => void;
};

export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function attemptModels(decision: RewriteDecision | undefined): string[] {
  if (!decision) return ['unknown'];
  if (decision.rewritten && decision.targets.length) return decision.targets;
  return [decision.model ?? 'unknown'];
}

function bodyForAttempt(decision: RewriteDecision | undefined, model: string): Buffer | undefined {
  if (!decision) return undefined;
  if (decision.rewritten) return buildRewriteBody(decision, model);
  return decision.body;
}

function cloneHeaders(headers: Headers): Headers {
  const next = new Headers();
  headers.forEach((value, key) => next.set(key, value));
  return next;
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

async function cancelBody(upstream: Response): Promise<void> {
  try { await upstream.body?.cancel(); } catch { /* ignore drain/cancel errors before retry */ }
}

function errorStatus(err: any): { statusCode: number; type: string; message: string } {
  if (err?.name === 'AbortError') return { statusCode: 504, type: 'upstream_timeout', message: 'Upstream timeout' };
  return { statusCode: 502, type: 'proxy_error', message: 'Upstream proxy error' };
}

export async function fetchUpstreamWithFailover(options: FetchUpstreamOptions): Promise<FetchUpstreamResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const models = attemptModels(options.decision);
  for (let attemptIndex = 0; attemptIndex < models.length; attemptIndex++) {
    const model = models[attemptIndex];
    const body = bodyForAttempt(options.decision, model);
    const bodyBytes = body?.length ?? 0;
    const estimatedInputTokens = estimateTokens(bodyBytes);
    const isLargeContext = estimatedInputTokens > options.largeContextThresholdTokens;
    let lease: TrafficLease;
    try {
      lease = await options.trafficLimiter.acquire({ model, userId: options.userId, estimatedInputTokens, isLargeContext });
    } catch (err: any) {
      throw new TrafficAcquireError(err?.message ?? 'traffic queue rejected', err, options.trafficLimiter.snapshot(), model);
    }

    const attemptHeaders = cloneHeaders(options.headers);
    if (body) attemptHeaders.set('content-length', String(body.length));
    else attemptHeaders.delete('content-length');
    const upstreamStarted = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), lease.timeoutMs);
    try {
      const upstream = await fetchImpl(options.upstreamUrl, { method: options.method, headers: attemptHeaders, body: body as any, duplex: 'half', signal: controller.signal });
      clearTimeout(timeout);
      const upstreamMs = Date.now() - upstreamStarted;
      if (isRetryableUpstreamStatus(upstream.status) && attemptIndex < models.length - 1) {
        await cancelBody(upstream);
        lease.release();
        options.log?.({ model, attemptIndex, attemptCount: models.length, upstreamStatus: upstream.status, retryReason: 'retryable_status' }, 'model rewrite failover retry');
        continue;
      }
      return { upstream, lease, model, body, bodyBytes, estimatedInputTokens, isLargeContext, queuedMs: lease.queuedMs, upstreamMs, attemptIndex, attemptCount: models.length };
    } catch (err: any) {
      clearTimeout(timeout);
      lease.release();
      if (attemptIndex < models.length - 1) {
        options.log?.({ model, attemptIndex, attemptCount: models.length, errorType: err?.name === 'AbortError' ? 'upstream_timeout' : 'proxy_error', error: err?.message, retryReason: 'request_error' }, 'model rewrite failover retry');
        continue;
      }
      const status = errorStatus(err);
      throw new ProxyFailoverError(status.message, status.statusCode, status.type, err, model);
    }
  }
  throw new ProxyFailoverError('Upstream proxy error', 502, 'proxy_error', undefined, 'unknown');
}
