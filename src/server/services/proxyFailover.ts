import { buildRewriteBody, type RewriteDecision } from './modelRewriteProxy.js';
import type { FinalFallbackConfig } from './finalFallback.js';
import type { ModelRateLimitLease } from './modelRateLimiter.js';

export type ModelRateLimiterLike = {
  acquire: (model: string) => Promise<ModelRateLimitLease>;
  snapshot: () => unknown;
};

export type FetchUpstreamResult = {
  upstream: Response;
  lease: ModelRateLimitLease;
  model: string;
  body?: Buffer;
  bodyBytes: number;
  estimatedInputTokens: number;
  isLargeContext: boolean;
  queuedMs: number;
  rateQueuedMs: number;
  rateLimitModel: string;
  rateLimitRpm: number | null;
  rateLimited: boolean;
  upstreamMs: number;
  timeoutMs: number;
  attemptIndex: number;
  attemptCount: number;
};

export class TrafficAcquireError extends Error {
  statusCode = 429;
  retryAfter = 10;
  type: string;
  constructor(message: string, public readonly cause: unknown, public readonly snapshot: unknown, public readonly model: string, public readonly attemptIndex: number, type = 'rate_queue_full', retryAfter = 10) {
    super(message);
    this.type = type;
    this.retryAfter = Math.max(1, retryAfter);
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
  finalFallback?: FinalFallbackConfig;
  disableModelFallback?: boolean;
  userId: string;
  largeContextThresholdTokens: number;
  modelRateLimiter: ModelRateLimiterLike;
  upstreamTimeoutFor: (model: string, isLargeContext: boolean) => number;
  fetchImpl?: FetchImpl;
  log?: (data: Record<string, unknown>, message: string) => void;
};

export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 401 || status === 413 || status === 429 || status >= 500;
}

function appendFallback(models: string[], decision: RewriteDecision | undefined, finalFallback: FinalFallbackConfig | undefined): string[] {
  const fallbackModel = finalFallback?.model?.trim();
  if (!finalFallback?.enabled || !fallbackModel || !decision?.parsedBody?.model) return models;
  if (models.includes(fallbackModel)) return models;
  return [...models, fallbackModel];
}

function attemptModels(decision: RewriteDecision | undefined, finalFallback: FinalFallbackConfig | undefined, disableModelFallback = false): string[] {
  const firstModel = !decision ? 'unknown' : decision.rewritten && decision.targets.length ? decision.targets[0] : decision.model ?? 'unknown';
  if (disableModelFallback) return [firstModel];
  const models = !decision ? ['unknown'] : decision.rewritten && decision.targets.length ? decision.targets : [decision.model ?? 'unknown'];
  return appendFallback(models, decision, finalFallback);
}

function bodyForAttempt(decision: RewriteDecision | undefined, model: string): Buffer | undefined {
  if (!decision) return undefined;
  if (decision.parsedBody && decision.model !== model) return buildRewriteBody(decision, model);
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
  const models = attemptModels(options.decision, options.finalFallback, options.disableModelFallback);
  for (let attemptIndex = 0; attemptIndex < models.length; attemptIndex++) {
    const model = models[attemptIndex];
    const body = bodyForAttempt(options.decision, model);
    const bodyBytes = body?.length ?? 0;
    const estimatedInputTokens = estimateTokens(bodyBytes);
    const isLargeContext = estimatedInputTokens > options.largeContextThresholdTokens;
    let lease: ModelRateLimitLease;
    try {
      lease = await options.modelRateLimiter.acquire(model);
    } catch (err: any) {
      throw new TrafficAcquireError(err?.message ?? 'model rate queue rejected', err, options.modelRateLimiter.snapshot(), model, attemptIndex, err?.type, err?.retryAfter);
    }

    const attemptHeaders = cloneHeaders(options.headers);
    if (body) attemptHeaders.set('content-length', String(body.length));
    else attemptHeaders.delete('content-length');
    const upstreamStarted = Date.now();
    const timeoutMs = options.upstreamTimeoutFor(model, isLargeContext);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(options.upstreamUrl, { method: options.method, headers: attemptHeaders, body: body as any, duplex: 'half', signal: controller.signal });
      clearTimeout(timeout);
      const upstreamMs = Date.now() - upstreamStarted;
      if (isRetryableUpstreamStatus(upstream.status) && attemptIndex < models.length - 1) {
        await cancelBody(upstream);
        lease.release();
        options.log?.({ model, attemptIndex, attemptCount: models.length, upstreamStatus: upstream.status, retryReason: 'retryable_status', timeoutMs, bodyBytes, estimatedInputTokens, isLargeContext, rateQueuedMs: lease.rateQueuedMs, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited }, 'model failover retry');
        continue;
      }
      return { upstream, lease, model, body, bodyBytes, estimatedInputTokens, isLargeContext, queuedMs: lease.rateQueuedMs, rateQueuedMs: lease.rateQueuedMs, rateLimitModel: lease.rateLimitModel, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited, upstreamMs, timeoutMs, attemptIndex, attemptCount: models.length };
    } catch (err: any) {
      clearTimeout(timeout);
      lease.release();
      if (attemptIndex < models.length - 1) {
        options.log?.({ model, attemptIndex, attemptCount: models.length, errorType: err?.name === 'AbortError' ? 'upstream_timeout' : 'proxy_error', error: err?.message, retryReason: 'request_error', timeoutMs, bodyBytes, estimatedInputTokens, isLargeContext, rateQueuedMs: lease.rateQueuedMs, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited }, 'model failover retry');
        continue;
      }
      const status = errorStatus(err);
      throw new ProxyFailoverError(status.message, status.statusCode, status.type, err, model);
    }
  }
  throw new ProxyFailoverError('Upstream proxy error', 502, 'proxy_error', undefined, 'unknown');
}
