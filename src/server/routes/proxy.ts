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
import { buildKeyModelNotAllowedErrorBody, evaluateKeyModelAccessInterceptor } from '../services/keyModelAccessInterceptor.js';
import { buildClientRateLimitErrorBody, ClientRateLimitAcquireError, type ClientRateLimitLease } from '../services/clientRateLimiter.js';
import type { ClientRateLimiter } from '../services/clientRateLimiter.js';
import type { ModelRateLimiter, ModelRateLimitLease } from '../services/modelRateLimiter.js';
import { buildTrafficLogMeta } from '../services/trafficLog.js';
import { timeoutForModel, type UpstreamTimeoutConfig } from '../services/upstreamTimeouts.js';
import type { ApiKeyLookupResult } from '../services/apiKeyCache.js';
import { applyUsageMultiplierToUsage, createUsageScalingSseTransform, resolveMultiplierForKey } from '../utils/usageMultiplier.js';

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

function readAllowFinalFallback(db: Database.Database, keyId: string | undefined): boolean {
  if (!keyId) return true;
  const row = db.prepare('SELECT allow_final_fallback FROM key_policies WHERE key_id = ?').get(keyId) as { allow_final_fallback?: number | null } | undefined;
  return row?.allow_final_fallback == null ? true : Number(row.allow_final_fallback) !== 0;
}

function effectiveFinalFallbackConfig(config: FinalFallbackConfig, allowFinalFallback: boolean): FinalFallbackConfig {
  return allowFinalFallback ? config : { ...config, enabled: false };
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

      if (method !== 'GET' && method !== 'HEAD') {
        const parsed = parseModelRewriteRequest(rawBody ?? Buffer.from(''), req.headers['content-type']);
        const modelAccess = evaluateKeyModelAccessInterceptor({
          db,
          authHeader: req.headers.authorization,
          rawModel: parsed.model,
          lookupKey,
          log: req.log,
        });
        if (modelAccess.blocked) {
          req.log.info({ keyId: modelAccess.keyId, model: modelAccess.model, route: req.raw.url?.split('?')[0] }, 'model access blocked');
          return reply.code(modelAccess.status).send(buildKeyModelNotAllowedErrorBody(modelAccess));
        }
      }

      const clientToken = extractBearerToken(req.headers.authorization);
      const clientKey = clientToken ? lookupKey(clientToken) : undefined;
      const allowFinalFallback = readAllowFinalFallback(db, clientKey?.id);
      const nowIso = new Date().toISOString();
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
          finalFallback: effectiveFinalFallbackConfig(finalFallbackStore.get(), allowFinalFallback),
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
        // Decide whether we need to scale token fields in the response body.
        // factor === 1 (the common case) means we skip the entire transform pipeline.
        let usageFactor = 1;
        if (clientKey?.id) {
          try {
            usageFactor = resolveMultiplierForKey(db, clientKey.id, nowIso).factor;
          } catch (err: any) {
            req.log.warn({ keyId: clientKey.id, error: err?.message }, 'failed to resolve usage multiplier; pass-through');
          }
        }
        // For JSON bodies we must drop upstream `content-length` after scaling, so we
        // collect skipped headers dynamically. For other content types pass-through is
        // byte-exact so we keep the original skip list.
        const skipHeaders = new Set(['connection', 'content-encoding', 'transfer-encoding']);
        result.upstream.headers.forEach((value, key) => {
          if (skipHeaders.has(key.toLowerCase())) return;
          reply.header(key, value);
        });
        if (!result.upstream.body) return reply.send();
        const upstreamContentType = (result.upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const canScaleJson = usageFactor !== 1 && upstreamContentType === 'application/json';
        const canScaleSse = usageFactor !== 1 && upstreamContentType === 'text/event-stream';

        if (canScaleJson) {
          req.log.debug({ keyId: clientKey?.id, factor: usageFactor, contentType: upstreamContentType }, 'scaling upstream usage by multiplier');
          try {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            const jsonBodyLimit = 50 * 1024 * 1024;
            for await (const chunk of result.upstream.body as any) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              totalBytes += buf.length;
              if (totalBytes > jsonBodyLimit) {
                req.log.warn({ keyId: clientKey?.id, totalBytes }, 'json response exceeded limit; pass-through');
                const raw = Buffer.concat(chunks);
                chunks.length = 0;
                // Drop stale content-length since we may have truncated.
                reply.removeHeader('content-length');
                releaseOnFinally = false;
                releaseClientOnFinally = false;
                result.lease?.release();
                releaseClientLease();
                return reply.send(raw);
              }
              chunks.push(buf);
            }
            const body = Buffer.concat(chunks);
            const parsed = JSON.parse(body.toString('utf-8'));
            let mutated = false;
            if (parsed && typeof parsed === 'object') {
              if (parsed.usage && typeof parsed.usage === 'object') {
                applyUsageMultiplierToUsage(parsed.usage, usageFactor);
                mutated = true;
              }
              if (parsed.message && typeof parsed.message === 'object' && parsed.message.usage && typeof parsed.message.usage === 'object') {
                applyUsageMultiplierToUsage(parsed.message.usage, usageFactor);
                mutated = true;
              }
            }
            if (!mutated) {
              reply.removeHeader('content-length');
              releaseOnFinally = false;
              releaseClientOnFinally = false;
              result.lease?.release();
              releaseClientLease();
              return reply.send(body);
            }
            const out = Buffer.from(JSON.stringify(parsed), 'utf-8');
            // Length changed; upstream content-length no longer applies.
            reply.removeHeader('content-length');
            releaseOnFinally = false;
            releaseClientOnFinally = false;
            result.lease?.release();
            releaseClientLease();
            return reply.send(out);
          } catch (err: any) {
            req.log.warn({ keyId: clientKey?.id, error: err?.message }, 'failed to scale upstream json usage; pass-through');
            // Fall through to default pass-through below (result.upstream.body already consumed;
            // the default branch is unsafe, so consume+cancel and emit an empty body).
            try { await result.upstream.body?.cancel(); } catch { /* ignore */ }
            releaseOnFinally = false;
            releaseClientOnFinally = false;
            result.lease?.release();
            releaseClientLease();
            reply.removeHeader('content-length');
            return reply.send();
          }
        }

        if (canScaleSse) {
          req.log.debug({ keyId: clientKey?.id, factor: usageFactor, contentType: upstreamContentType }, 'scaling upstream usage by multiplier (sse)');
          const transform = createUsageScalingSseTransform(usageFactor);
          const source = Readable.fromWeb(result.upstream.body as any);
          source.on('error', (err: Error) => {
            req.log.warn({ keyId: clientKey?.id, error: err.message }, 'upstream body stream error');
            transform.destroy(err);
          });
          source.pipe(transform);
          const stream = transform;
          const streamLease = result.lease;
          releaseOnFinally = false;
          releaseClientOnFinally = false;
          let streamLeaseReleased = false;
          const releaseStreamLease = () => {
            if (streamLeaseReleased) return;
            streamLeaseReleased = true;
            // Cancel the upstream source so the Web ReadableStream is drained and
            // the upstream TCP connection can be reused.
            try { source.destroy(); } catch { /* ignore */ }
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
        }

        const stream = Readable.fromWeb(result.upstream.body as any);
        const streamLease = result.lease;
        releaseOnFinally = false;
        releaseClientOnFinally = false;
        let streamLeaseReleased = false;
        const releaseStreamLease = () => {
          if (streamLeaseReleased) return;
          streamLeaseReleased = true;
          // Cancel the upstream source so the Web ReadableStream is drained and
          // the upstream TCP connection can be reused.
          try { stream.destroy(); } catch { /* ignore */ }
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
