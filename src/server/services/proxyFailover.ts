import { buildRewriteBody, type RewriteDecision } from './modelRewriteProxy.js';
import { normalizeFinalFallbackModels } from '../../shared/finalFallback.js';
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
  retryAfter?: number;
  upstreamStatus?: number;
  errorType?: string;
  constructor(message: string, public readonly statusCode: number, public readonly type: string, public readonly cause: unknown, public readonly model: string, details: { retryAfter?: number; upstreamStatus?: number; errorType?: string } = {}) {
    super(message);
    this.retryAfter = details.retryAfter;
    this.upstreamStatus = details.upstreamStatus;
    this.errorType = details.errorType;
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

type AttemptModel = {
  model: string;
  isFinalFallback: boolean;
};

function appendFallback(models: AttemptModel[], decision: RewriteDecision | undefined, finalFallback: FinalFallbackConfig | undefined): AttemptModel[] {
  if (!finalFallback?.enabled || !decision?.parsedBody?.model) return models;
  const seen = new Set(models.map(({ model }) => model));
  const fallbackModels = normalizeFinalFallbackModels(finalFallback).filter(model => {
    if (seen.has(model)) return false;
    seen.add(model);
    return true;
  });
  return [...models, ...fallbackModels.map(model => ({ model, isFinalFallback: true }))];
}

function attemptModels(decision: RewriteDecision | undefined, finalFallback: FinalFallbackConfig | undefined, disableModelFallback = false): AttemptModel[] {
  const firstModel = !decision ? 'unknown' : decision.rewritten && decision.targets.length ? decision.targets[0] : decision.model ?? 'unknown';
  if (disableModelFallback) return [{ model: firstModel, isFinalFallback: false }];
  const modelNames = !decision ? ['unknown'] : decision.rewritten && decision.targets.length ? decision.targets : [decision.model ?? 'unknown'];
  const models = modelNames.map(model => ({ model, isFinalFallback: false }));
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

function finalFallbackBusyError(cause: unknown, model: string, details: { upstreamStatus?: number; errorType?: string } = {}): ProxyFailoverError {
  return new ProxyFailoverError('Server busy, retry later', 429, 'server_overloaded', cause, model, { retryAfter: 10, ...details });
}

function hasLaterAttempt(models: AttemptModel[], attemptIndex: number): boolean {
  return attemptIndex < models.length - 1;
}

function shouldRetryStatus(upstreamStatus: number, attempt: AttemptModel, models: AttemptModel[], attemptIndex: number): boolean {
  if (!hasLaterAttempt(models, attemptIndex)) return false;
  if (attempt.isFinalFallback && upstreamStatus >= 400) return true;
  return isRetryableUpstreamStatus(upstreamStatus);
}

export async function fetchUpstreamWithFailover(options: FetchUpstreamOptions): Promise<FetchUpstreamResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const models = attemptModels(options.decision, options.finalFallback, options.disableModelFallback);
  for (let attemptIndex = 0; attemptIndex < models.length; attemptIndex++) {
    const attempt = models[attemptIndex];
    const model = attempt.model;
    const body = bodyForAttempt(options.decision, model);
    const bodyBytes = body?.length ?? 0;
    const estimatedInputTokens = estimateTokens(bodyBytes);
    const isLargeContext = estimatedInputTokens > options.largeContextThresholdTokens;
    let lease: ModelRateLimitLease;
    try {
      lease = await options.modelRateLimiter.acquire(model);
    } catch (err: any) {
      if (attempt.isFinalFallback) {
        const errorType = err?.type ?? 'rate_queue_full';
        if (hasLaterAttempt(models, attemptIndex)) {
          options.log?.({ model, attemptIndex, attemptCount: models.length, errorType, error: err?.message, retryReason: 'rate_queue_rejected', bodyBytes, estimatedInputTokens, isLargeContext }, 'model failover retry');
          continue;
        }
        throw finalFallbackBusyError(err, model, { errorType });
      }
      throw new TrafficAcquireError(err?.message ?? 'model rate queue rejected', err, options.modelRateLimiter.snapshot(), model, attemptIndex, err?.type, err?.retryAfter);
    }
    let leaseReleased = false;
    const releaseLease = () => {
      if (leaseReleased) return;
      leaseReleased = true;
      lease.release();
    };

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
      if (shouldRetryStatus(upstream.status, attempt, models, attemptIndex)) {
        await cancelBody(upstream);
        releaseLease();
        options.log?.({ model, attemptIndex, attemptCount: models.length, upstreamStatus: upstream.status, retryReason: 'retryable_status', timeoutMs, bodyBytes, estimatedInputTokens, isLargeContext, rateQueuedMs: lease.rateQueuedMs, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited }, 'model failover retry');
        continue;
      }
      if (upstream.status >= 400 && attempt.isFinalFallback) {
        await cancelBody(upstream);
        releaseLease();
        throw finalFallbackBusyError(undefined, model, { upstreamStatus: upstream.status });
      }
      return { upstream, lease, model, body, bodyBytes, estimatedInputTokens, isLargeContext, queuedMs: lease.rateQueuedMs, rateQueuedMs: lease.rateQueuedMs, rateLimitModel: lease.rateLimitModel, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited, upstreamMs, timeoutMs, attemptIndex, attemptCount: models.length };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err instanceof ProxyFailoverError) {
        releaseLease();
        throw err;
      }
      releaseLease();
      if (hasLaterAttempt(models, attemptIndex)) {
        options.log?.({ model, attemptIndex, attemptCount: models.length, errorType: err?.name === 'AbortError' ? 'upstream_timeout' : 'proxy_error', error: err?.message, retryReason: 'request_error', timeoutMs, bodyBytes, estimatedInputTokens, isLargeContext, rateQueuedMs: lease.rateQueuedMs, rateLimitRpm: lease.rateLimitRpm, rateLimited: lease.rateLimited }, 'model failover retry');
        continue;
      }
      const status = errorStatus(err);
      if (attempt.isFinalFallback) throw finalFallbackBusyError(err, model, { errorType: status.type });
      throw new ProxyFailoverError(status.message, status.statusCode, status.type, err, model);
    }
  }
  throw new ProxyFailoverError('Upstream proxy error', 502, 'proxy_error', undefined, 'unknown');
}
