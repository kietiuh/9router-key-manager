import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { openDb } from './db/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readApiKeys, readUsageHistorySince } from './parsers/reader.js';
import { summarizeKeyUsage } from './services/usage.js';
import { ingestUsageHistory, readStoredUsageForKeys } from './services/usageStore.js';
import { startOfVietnamDayUtc } from './utils/time.js';
import { startWatcher } from './services/watcher.js';
import { rollbackModelRewriteSelection, selectModelRewriteTargets, type RewriteTargetPlan } from './services/modelRewrite.js';
import { applyRewritePlan, parseModelRewriteRequest } from './services/modelRewriteProxy.js';
import { createFinalFallbackStore } from './services/finalFallback.js';
import { fetchUpstreamWithFailover, ProxyFailoverError, TrafficAcquireError } from './services/proxyFailover.js';
import { ModelRateLimiter, type ModelRateLimitLease } from './services/modelRateLimiter.js';
import { createModelRateLimitConfigStore } from './services/modelRateLimitConfig.js';
import { buildClientRateLimitErrorBody, ClientRateLimitAcquireError, ClientRateLimiter, type ClientRateLimitLease } from './services/clientRateLimiter.js';
import { createClientRateLimitConfigStore } from './services/clientRateLimitConfig.js';
import { readUpstreamTimeoutConfig, timeoutForModel } from './services/upstreamTimeouts.js';
import { buildImageProxyUrl, getImageProxyConfig, isImageProxyPath, maybeRewriteImageModel, parseImageUsage } from './services/imageProxy.js';
import { imageProxyNeedsServerKey } from '../shared/imageProxy.js';
import { buildQuotaErrorBody, evaluateQuotaInterceptor, extractBearerToken } from './services/quotaInterceptor.js';
import { buildKeyExpiredErrorBody, evaluateKeyAccessInterceptor } from './services/keyAccessInterceptor.js';
import { maybeUnlockQuotaLockout } from './services/quotaUnlock.js';
import { createApiKeyCache } from './services/apiKeyCache.js';
import { buildTrafficLogMeta } from './services/trafficLog.js';
import { nineRouterLogMetrics } from './services/nineRouterLogMetrics.js';
import { resolvedPolicies as readResolvedPolicies, usageFiltersForPolicies, usageImportSince } from './services/policyUsage.js';
import { createPublicImageStore } from './services/publicImageStore.js';
import { registerPublicImageRoutes } from './routes/publicImages.js';
import { registerAdminRoutes } from './routes/admin.js';

export type ServerAppOptions = {
  adminPassword?: string;
  sessionSecret?: string;
  dbPath?: string;
  disableBackgroundJobs?: boolean;
};

export async function createServerApp(options: ServerAppOptions = {}) {
const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
if (!adminPassword) throw new Error('ADMIN_PASSWORD is required');
const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET ?? crypto.createHash('sha256').update(`${adminPassword}:dev-secret`).digest('hex');
const sessionMaxAge = Number(process.env.SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 30);
const secureCookie = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(o => o.trim()).filter(Boolean));
const nineRouterUpstream = (process.env.NINE_ROUTER_UPSTREAM ?? 'http://127.0.0.1:20128').replace(/\/$/, '');
const app = Fastify({ logger: true });
const db = openDb(options.dbPath);
const upstreamTimeoutConfig = readUpstreamTimeoutConfig(process.env);
const modelRateLimitStore = createModelRateLimitConfigStore(db);
const modelRateLimiter = new ModelRateLimiter(modelRateLimitStore.get());
const clientRateLimitStore = createClientRateLimitConfigStore(db);
const clientRateLimiter = new ClientRateLimiter(clientRateLimitStore.get());
const includeLimiterInSuccessLogs = process.env.TRAFFIC_LOG_LIMITER_SNAPSHOT === 'true';
const publicImageDir = process.env.PUBLIC_IMAGE_DIR ?? path.join(os.homedir(), '.local/state/9router-key-manager/public-images');
const publicImageTtlMs = Number(process.env.PUBLIC_IMAGE_TTL_HOURS ?? 24) * 60 * 60 * 1000;
const publicImageStore = createPublicImageStore({ db, publicImageDir, publicImageTtlMs });
const {
  dailyImageUsageForKey,
  imageUsageSummary,
  recordImageUsage,
  recordImageProxyUsage,
} = publicImageStore;
const finalFallbackStore = createFinalFallbackStore(db);
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), credentials: true });
await app.register(cookie, { secret: sessionSecret });

const webRoot = process.env.WEB_ROOT ?? path.resolve(process.cwd(), 'dist/web');
if (fs.existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });

const LoginBody = z.object({ password: z.string() });
const PublicKeyCheckBody = z.object({ key: z.string().min(8) });

function isAuthed(req: any) { return req.unsignCookie(req.cookies?.admin_session ?? '').valid; }
async function requireAuth(req: any, reply: any) { if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' }); }

function ensurePolicies() { const keys = readApiKeys(); const defaultStart = startOfVietnamDayUtc(); const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start, reset_policy) VALUES (?, ?, ?, ?)'); for (const key of keys) insert.run(key.id, key.name, defaultStart, 'daily'); return keys; }
const apiKeyCache = createApiKeyCache({ load: ensurePolicies, ttlMs: Number(process.env.API_KEY_CACHE_TTL_MS ?? 5000) });
const usageRefreshMinIntervalMs = Number(process.env.USAGE_REFRESH_MIN_INTERVAL_MS ?? 30_000);
const usageRefreshOverlapMs = Number(process.env.USAGE_REFRESH_OVERLAP_MS ?? 5 * 60_000);
const usageSummaryCacheTtlMs = Number(process.env.USAGE_SUMMARY_CACHE_TTL_MS ?? 15_000);
let lastUsageRefreshAt = 0;
let usageSummaryCache: { createdAt: number; data: ReturnType<typeof summarizeKeyUsage> } | null = null;

function refreshUsageStore(force = false) {
  const now = Date.now();
  if (!force && lastUsageRefreshAt && now - lastUsageRefreshAt < usageRefreshMinIntervalMs) return 0;
  const rows = readUsageHistorySince(usageImportSince(db, usageRefreshOverlapMs));
  const inserted = ingestUsageHistory(db, rows);
  lastUsageRefreshAt = now;
  return inserted;
}

function invalidateUsageSummaryCache() { usageSummaryCache = null; }

function sortUsageSummaries(data: ReturnType<typeof summarizeKeyUsage>) {
  return data.sort((a, b) => {
    const rank = { danger: 0, expired: 1, warning: 2, unlimited: 3, ok: 4, inactive: 5 } as const;
    return rank[a.status] - rank[b.status] || (Date.parse(b.lastUsageAt ?? '') || 0) - (Date.parse(a.lastUsageAt ?? '') || 0) || (b.percentOfLimit ?? -1) - (a.percentOfLimit ?? -1);
  });
}

function usageResponse() {
  const now = Date.now();
  if (usageSummaryCache && now - usageSummaryCache.createdAt < usageSummaryCacheTtlMs) return usageSummaryCache.data;
  const keys = ensurePolicies();
  refreshUsageStore();
  const policies = readResolvedPolicies(db, { imageDailyUsageForKey: dailyImageUsageForKey });
  const usage = readStoredUsageForKeys(db, usageFiltersForPolicies(keys, policies));
  const data = sortUsageSummaries(summarizeKeyUsage(keys, usage, policies));
  usageSummaryCache = { createdAt: Date.now(), data };
  return data;
}
function maybeUnlockQuotaAfterPolicyChange(keyId: string) {
  const locked = db.prepare('SELECT 1 FROM auto_disabled_keys WHERE key_id = ?').get(keyId);
  if (!locked) return;
  refreshUsageStore(true);
  const keys = ensurePolicies();
  const key = keys.find(k => k.id === keyId);
  if (!key) return;
  const policies = readResolvedPolicies(db, { imageDailyUsageForKey: dailyImageUsageForKey });
  const policy = policies.find(p => p.key_id === keyId);
  const usage = readStoredUsageForKeys(db, [{ apiKey: key.key, sinceIso: policy?.window_start }]);
  const summary = summarizeKeyUsage([key], usage, policy ? [policy] : []).at(0);
  if (!summary) return;
  const unlock = maybeUnlockQuotaLockout(db, summary, { hardDisable: process.env.HARD_DISABLE === 'true' });
  if (unlock.unlocked) app.log.info({ keyId, enableChanged: unlock.enableResult?.changed ?? false }, 'quota lockout cleared after policy update');
}

function findPublicKey(key: string) { const clean = key.trim(); return apiKeyCache.getKeys().find(k => k.key === clean && k.isActive !== false); }
function findPublicKeyAny(key: string) { const clean = key.trim(); return apiKeyCache.getKeys().find(k => k.key === clean); }
function autoDisabledReason(keyId: string): string | null {
  const row = db.prepare('SELECT reason FROM auto_disabled_keys WHERE key_id = ? ORDER BY disabled_for_window_start DESC LIMIT 1').get(keyId) as { reason?: string } | undefined;
  return row?.reason ?? null;
}
function lastDisableAuditMessage(keyId: string): string | null {
  const row = db.prepare("SELECT message FROM audit_log WHERE key_id = ? AND action IN ('disable','auto.disable') ORDER BY id DESC LIMIT 1").get(keyId) as { message?: string } | undefined;
  return row?.message ?? null;
}
function maskedUser(req: any) { const auth = String(req.headers?.authorization ?? ''); if (auth) return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12); return String(req.ip ?? 'unknown'); }
function clientRateLimitKey(token: string, key?: { id: string }) {
  if (key?.id) return key.id;
  return `unknown:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}
app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
app.get('/api/auth/status', async (req) => ({ authenticated: isAuthed(req) }));
app.post('/api/auth/login', async (req, reply) => { const body = LoginBody.parse(req.body); if (body.password !== adminPassword) return reply.code(401).send({ error: 'invalid password' }); reply.setCookie('admin_session', 'ok', { path: '/', signed: true, httpOnly: true, secure: secureCookie, sameSite: 'lax', maxAge: sessionMaxAge }); return { ok: true }; });
app.post('/api/auth/logout', async (_req, reply) => { reply.clearCookie('admin_session', { path: '/', secure: secureCookie, sameSite: 'lax' }); return reply.code(204).send(); });

app.post('/api/public/key-check', async (req, reply) => {
  const parsed = PublicKeyCheckBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid key format' });
  const match = findPublicKeyAny(parsed.data.key);
  if (!match) return reply.code(404).send({ error: 'key not found' });
  refreshUsageStore();
  const policy = readResolvedPolicies(db, { imageDailyUsageForKey: dailyImageUsageForKey }).find(p => p.key_id === match.id);
  const usage = readStoredUsageForKeys(db, [{ apiKey: match.key, sinceIso: policy?.window_start }]);
  const summary = summarizeKeyUsage([match], usage, policy ? [policy] : []).at(0);
  if (!summary) return reply.code(404).send({ error: 'key not found' });
  if (!match.isActive) {
    const reason = autoDisabledReason(match.id) ?? lastDisableAuditMessage(match.id);
    if (reason) summary.statusReason = reason;
  }
  const { modelUsage: _modelUsage, models: _models, ...publicSummary } = summary;
  return publicSummary;
});

await registerPublicImageRoutes(app, {
  db,
  findPublicKey,
  nineRouterUpstream,
  publicImageStore,
  queue: {
    maxGlobal: Number(process.env.PUBLIC_IMAGE_QUEUE_GLOBAL ?? 3),
    maxPerKey: Number(process.env.PUBLIC_IMAGE_QUEUE_PER_KEY ?? 2),
    ttlMs: Number(process.env.PUBLIC_IMAGE_JOB_TTL_MINUTES ?? 60) * 60 * 1000,
  },
  serverImageProxyKey: () => process.env.IMAGE_PROXY_API_KEY,
});

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

    const lookupKey = (token: string) => apiKeyCache.lookup(token);
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

    const imageProxyConfig = getImageProxyConfig(db);
    if (imageProxyConfig.enabled && isImageProxyPath(req.raw.url?.split('?')[0] ?? '') && method !== 'GET' && method !== 'HEAD') {
      const totalStarted = Date.now();
      try {
        if (imageProxyNeedsServerKey(imageProxyConfig)) {
          const serverKey = process.env.IMAGE_PROXY_API_KEY;
          if (!serverKey) return reply.code(503).send({ error: { message: 'Image proxy server key is not configured', type: 'image_proxy_config' } });
          headers.set('authorization', `Bearer ${serverKey}`);
        }
        const body = maybeRewriteImageModel(rawBody, req.headers['content-type'], imageProxyConfig.modelOverride);
        if (body) headers.set('content-length', String(body.length));
        else headers.delete('content-length');
        const upstreamStarted = Date.now();
        const upstream = await fetch(buildImageProxyUrl(imageProxyConfig, req.raw.url ?? '/v1/images/generations'), { method, headers, body: body as any, duplex: 'half' } as RequestInit & { duplex: 'half' });
        const upstreamMs = Date.now() - upstreamStarted;
        const responseBuffer = Buffer.from(await upstream.arrayBuffer());
        const usage = parseImageUsage(body, responseBuffer.length, upstream.status);
        recordImageProxyUsage(usage);
        req.log.info({ upstreamBaseUrl: imageProxyConfig.upstreamBaseUrl, upstreamStatus: upstream.status, upstreamMs, totalMs: Date.now() - totalStarted, bodyBytes: body?.length ?? 0, responseBytes: responseBuffer.length }, 'image request proxied direct');
        reply.header('x-image-proxy', 'direct');
        if (clientLease?.clientRateRemaining != null) reply.header('x-ratelimit-remaining', String(clientLease.clientRateRemaining));
        if (clientLease?.clientRateResetAt) reply.header('x-ratelimit-reset', clientLease.clientRateResetAt);
        reply.header('x-upstream-time-ms', String(upstreamMs));
        reply.code(upstream.status);
        upstream.headers.forEach((value, key) => {
          if (!['connection', 'content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) reply.header(key, value);
        });
        return reply.send(responseBuffer);
      } catch (err: any) {
        req.log.error({ error: err?.message, totalMs: Date.now() - totalStarted }, 'image direct proxy failed');
        recordImageProxyUsage({ kind: 'proxy', model: imageProxyConfig.modelOverride || 'unknown', status: 'error', error: err?.message, imageCount: 1 });
        return reply.code(502).send({ error: { message: 'Image upstream proxy error', type: 'image_proxy_error' } });
      } finally {
        releaseClientLease();
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

await registerAdminRoutes(app, {
  db,
  requireAuth,
  usageResponse,
  imageUsageSummary,
  recordImageUsage,
  finalFallbackStore,
  modelRateLimitStore,
  modelRateLimiter,
  clientRateLimitStore,
  clientRateLimiter,
  ensurePolicies,
  maybeUnlockQuotaAfterPolicyChange,
  invalidateApiKeyCache: () => apiKeyCache.invalidate(),
  invalidateUsageSummaryCache,
  hardDisable: () => process.env.HARD_DISABLE === 'true',
});

if (!options.disableBackgroundJobs && process.env.WATCHER_ENABLED !== 'false') startWatcher(db, Number(process.env.WATCH_INTERVAL_MS ?? 60_000), { hardDisable: process.env.HARD_DISABLE === 'true' });
if (!options.disableBackgroundJobs) nineRouterLogMetrics.start();

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => { if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' }); return reply.sendFile('index.html'); });
return app;
}
