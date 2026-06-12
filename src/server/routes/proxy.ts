import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { FinalFallbackConfig } from '../services/finalFallback.js';
import { applyRewritePlan, parseModelRewriteRequest } from '../services/modelRewriteProxy.js';
import { rollbackModelRewriteSelection, selectModelRewriteTargets, type RewriteTargetPlan } from '../services/modelRewrite.js';
import { fetchUpstreamWithFailover, ProxyFailoverError, TrafficAcquireError } from '../services/proxyFailover.js';
import { buildQuotaErrorBody, evaluateQuotaInterceptor, extractBearerToken } from '../services/quotaInterceptor.js';
import { buildKeyExpiredErrorBody, evaluateKeyAccessInterceptor } from '../services/keyAccessInterceptor.js';
import { buildClientRateLimitErrorBody, ClientRateLimitAcquireError, type ClientRateLimitLease } from '../services/clientRateLimiter.js';
import type { ClientRateLimiter } from '../services/clientRateLimiter.js';
import type { ModelRateLimiter, ModelRateLimitLease } from '../services/modelRateLimiter.js';
import { buildTrafficLogMeta } from '../services/trafficLog.js';
import { timeoutForModel, type UpstreamTimeoutConfig } from '../services/upstreamTimeouts.js';
import type { ApiKeyLookupResult } from '../services/apiKeyCache.js';

export type ProxyRouteOptions = {
  db: Database.Database;
  nineRouterUpstream: string;
  upstreamTimeoutConfig: UpstreamTimeoutConfig;
  finalFallbackStore: {
    get: () => FinalFallbackConfig;
  };
  modelRateLimiter: ModelRateLimiter;
  clientRateLimiter: ClientRateLimiter;
  lookupKey: (token: string) => ApiKeyLookupResult | undefined;
  includeLimiterInSuccessLogs: boolean;
  fetchImpl: typeof fetch;
};

function maskedUser(req: any) {
  const auth = String(req.headers?.authorization ?? '');
  if (auth) return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12);
  return String(req.ip ?? 'unknown');
}

function clientRateLimitKey(token: string, key?: { id: string }) {
  if (key?.id) return key.id;
  return `unknown:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

export async function registerProxyRoutes(app: FastifyInstance, options: ProxyRouteOptions) {
  const {
    db,
    nineRouterUpstream,
    upstreamTimeoutConfig,
    finalFallbackStore,
    modelRateLimiter,
    clientRateLimiter,
    lookupKey,
    includeLimiterInSuccessLogs,
    fetchImpl,
  } = options;

  app.register(async proxyRoutes => {
    proxyRoutes.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    proxyRoutes.all('/v1/*', async (req, reply) => {
      const method = req.method.toUpperCase();
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (['host', 'connection', 'content-length'].includes(lower)) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(key, v);
        else headers.set(key, String(value));
      }

      const rawBody = method !== 'GET' && method !== 'HEAD'
        ? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body == null ? '' : typeof req.body === 'string' ? req.body : JSON.stringify(req.body)))
        : undefined;

      const keyAccess = evaluateKeyAccessInterceptor({
        db,
        authHeader: req.headers.authorization,
        lookupKey,
      });
      if (keyAccess.blocked) {
        req.log.info({ keyId: keyAccess.keyId, expiresAt: keyAccess.expiresAt }, 'expired key intercept');
        return reply.code(keyAccess.status).send(buildKeyExpiredErrorBody(keyAccess));
      }

      const quota = evaluateQuotaInterceptor({
        db,
        authHeader: req.headers.authorization,
        lookupKey,
      });
      if (quota.blocked) {
        req.log.info({ keyId: quota.keyId, retryAfter: quota.retryAfterSeconds, resetAt: quota.resetAt, reason: quota.reason }, 'quota intercept');
        reply.header('retry-after', String(quota.retryAfterSeconds));
        if (quota.resetAt) reply.header('x-ratelimit-reset', quota.resetAt);
        return reply.code(429).send(buildQuotaErrorBody(quota));
      }

      const clientToken = extractBearerToken(req.headers.authorization);
      const clientKey = clientToken ? lookupKey(clientToken) : undefined;
      const clientLimitKey = clientToken ? clientRateLimitKey(clientToken, clientKey) : undefined;
      let clientLease: ClientRateLimitLease | undefined;
      let clientLeaseReleased = false;
      const releaseClientLease = () => {
        if (clientLeaseReleased) return;
        clientLeaseReleased = true;
        clientLease?.release();
      };
      if (clientLimitKey) {
        try {
          clientLease = clientRateLimiter.acquire(clientLimitKey);
        } catch (err: any) {
          if (err instanceof ClientRateLimitAcquireError) {
            req.log.warn({ keyId: err.keyId, errorType: err.type, retryAfter: err.retryAfter, resetAt: err.resetAt, limiter: err.snapshot }, 'client rate limited request rejected');
            reply.header('retry-after', String(err.retryAfter));
            if (err.resetAt) reply.header('x-ratelimit-reset', err.resetAt);
            return reply.code(err.statusCode).send(buildClientRateLimitErrorBody(err));
          }
          throw err;
        }
      }

      let decision;
      let rewritePlan: RewriteTargetPlan | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const parsed = parseModelRewriteRequest(rawBody ?? Buffer.from(''), req.headers['content-type']);
        rewritePlan = parsed.model ? selectModelRewriteTargets(db, parsed.model) : undefined;
        decision = applyRewritePlan(parsed, rewritePlan);
        if (decision.rewritten) req.log.info({ fromModel: decision.fromModel, toModel: decision.toModel, targets: decision.targets }, 'model rewritten');
      }

      const totalStarted = Date.now();
      const userId = maskedUser(req);
      const largeContextThresholdTokens = upstreamTimeoutConfig.largeContextThresholdTokens;
      const disableModelFallback = req.raw.url?.split('?')[0] === '/v1/audio/speech';
      let lease: ModelRateLimitLease | undefined;
      let result;
      let releaseOnFinally = true;
      let releaseClientOnFinally = true;
      try {
        result = await fetchUpstreamWithFailover({
          upstreamUrl: `${nineRouterUpstream}${req.raw.url}`,
          method,
          headers,
          decision,
          finalFallback: finalFallbackStore.get(),
          disableModelFallback,
          userId,
          largeContextThresholdTokens,
          modelRateLimiter,
          upstreamTimeoutFor: (model, isLargeContext) => timeoutForModel(upstreamTimeoutConfig, model, isLargeContext),
          fetchImpl,
          log: (data, message) => req.log.info(data, message),
        });
        lease = result.lease;
        req.log.info(buildTrafficLogMeta({
          model: result.model,
          userId,
          bodyBytes: result.bodyBytes,
          estimatedInputTokens: result.estimatedInputTokens,
          isLargeContext: result.isLargeContext,
          queuedMs: result.queuedMs,
          rateQueuedMs: result.rateQueuedMs,
          rateLimitModel: result.rateLimitModel,
          rateLimitRpm: result.rateLimitRpm,
          rateLimited: result.rateLimited,
          upstreamMs: result.upstreamMs,
          upstreamTimeoutMs: result.timeoutMs,
          totalMs: Date.now() - totalStarted,
          upstreamStatus: result.upstream.status,
          attemptIndex: result.attemptIndex,
          attemptCount: result.attemptCount,
          clientRateLimited: clientLease?.clientLimited ?? false,
          clientRateLimitRpm: clientLease?.clientRateLimitRpm ?? null,
          clientConcurrencyLimit: clientLease?.clientConcurrencyLimit ?? null,
          clientRateRemaining: clientLease?.clientRateRemaining ?? null,
          clientActive: clientLease?.clientActive ?? 0,
          limiter: modelRateLimiter.snapshot(),
        }, { includeLimiter: includeLimiterInSuccessLogs }), 'traffic proxied request');
        if (clientLease?.clientRateRemaining != null) reply.header('x-ratelimit-remaining', String(clientLease.clientRateRemaining));
        if (clientLease?.clientRateResetAt) reply.header('x-ratelimit-reset', clientLease.clientRateResetAt);
        reply.header('x-rate-queue-time-ms', String(result.rateQueuedMs));
        reply.header('x-upstream-time-ms', String(result.upstreamMs));
        reply.code(result.upstream.status);
        result.upstream.headers.forEach((value, key) => {
          if (!['connection', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) reply.header(key, value);
        });
        if (!result.upstream.body) return reply.send();
        const stream = Readable.fromWeb(result.upstream.body as any);
        const streamLease = result.lease;
        releaseOnFinally = false;
        releaseClientOnFinally = false;
        let streamLeaseReleased = false;
        const releaseStreamLease = () => {
          if (streamLeaseReleased) return;
          streamLeaseReleased = true;
          streamLease.release();
          releaseClientLease();
        };
        stream.once('close', releaseStreamLease);
        stream.once('error', releaseStreamLease);
        stream.once('end', releaseStreamLease);
        try {
          return reply.send(stream);
        } catch (sendErr) {
          releaseStreamLease();
          throw sendErr;
        }
      } catch (err: any) {
        if (err instanceof TrafficAcquireError) {
          if (err.attemptIndex === 0 && rewritePlan) rollbackModelRewriteSelection(db, rewritePlan);
          req.log.warn({ model: err.model, userId, errorType: err.type, error: err.message, limiter: err.snapshot }, 'model rate limited request rejected');
          reply.header('retry-after', String(err.retryAfter));
          return reply.code(err.statusCode).send({ error: { message: 'Server busy, retry later', type: err.type, retry_after: err.retryAfter } });
        }
        if (err instanceof ProxyFailoverError) {
          req.log.error({ model: err.model, userId, totalMs: Date.now() - totalStarted, errorType: err.type, upstreamStatus: err.upstreamStatus, upstreamErrorType: err.errorType, upstreamError: err.cause instanceof Error ? err.cause.message : undefined, error: err.message }, 'traffic proxied request failed');
          if (err.retryAfter) reply.header('retry-after', String(err.retryAfter));
          return reply.code(err.statusCode).send({ error: { message: err.message, type: err.type, ...(err.retryAfter ? { retry_after: err.retryAfter } : {}) } });
        }
        req.log.error({ userId, totalMs: Date.now() - totalStarted, errorType: 'proxy_error', error: err?.message }, 'traffic proxied request failed');
        return reply.code(502).send({ error: { message: 'Upstream proxy error', type: 'proxy_error' } });
      } finally {
        if (releaseOnFinally) lease?.release();
        if (releaseClientOnFinally) releaseClientLease();
      }
    });
  });
}
