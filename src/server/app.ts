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
import { runWatcherOnce, startWatcher } from './services/watcher.js';
import { getModelRewriteConfig, rollbackModelRewriteSelection, saveModelRewriteConfig, selectModelRewriteTargets, type RewriteTargetPlan } from './services/modelRewrite.js';
import { applyRewritePlan, parseModelRewriteRequest } from './services/modelRewriteProxy.js';
import { createFinalFallbackStore } from './services/finalFallback.js';
import { fetchUpstreamWithFailover, ProxyFailoverError, TrafficAcquireError } from './services/proxyFailover.js';
import { ModelRateLimiter, type ModelRateLimitLease } from './services/modelRateLimiter.js';
import { createModelRateLimitConfigStore } from './services/modelRateLimitConfig.js';
import { buildClientRateLimitErrorBody, ClientRateLimitAcquireError, ClientRateLimiter, type ClientRateLimitLease } from './services/clientRateLimiter.js';
import { createClientRateLimitConfigStore } from './services/clientRateLimitConfig.js';
import { readUpstreamTimeoutConfig, timeoutForModel } from './services/upstreamTimeouts.js';
import { buildImageProxyUrl, getImageProxyConfig, isImageProxyPath, maybeRewriteImageModel, parseImageUsage, saveImageProxyConfig } from './services/imageProxy.js';
import { imageProxyNeedsServerKey } from '../shared/imageProxy.js';
import { buildQuotaErrorBody, evaluateQuotaInterceptor, extractBearerToken } from './services/quotaInterceptor.js';
import { buildKeyExpiredErrorBody, evaluateKeyAccessInterceptor } from './services/keyAccessInterceptor.js';
import { maybeUnlockQuotaLockout } from './services/quotaUnlock.js';
import { buildConfigStatus } from './configStatus.js';
import { createApiKeyCache } from './services/apiKeyCache.js';
import { buildTrafficLogMeta } from './services/trafficLog.js';
import { nineRouterLogMetrics } from './services/nineRouterLogMetrics.js';
import { resolvedPolicies as readResolvedPolicies, usageFiltersForPolicies, usageImportSince } from './services/policyUsage.js';
import { createPublicImageStore } from './services/publicImageStore.js';
import { registerPublicImageRoutes } from './routes/publicImages.js';

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

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(), imageDailyLimit: z.number().int().positive().nullable().optional(), windowStart: z.string().optional(), windowEnd: z.string().nullable().optional(), expiresAt: z.string().nullable().optional(), resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(), actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(), notes: z.string().nullable().optional(), usageMultiplier: z.number().min(0).max(100).optional()
});
const LoginBody = z.object({ password: z.string() });
const PublicKeyCheckBody = z.object({ key: z.string().min(8) });
const ImageUsageBody = z.object({ keyId: z.string().optional(), apiKey: z.string().optional(), kind: z.string(), model: z.string(), size: z.string().optional(), promptPreview: z.string().optional(), promptHash: z.string().optional(), inputFile: z.string().optional(), outputFile: z.string().optional(), drivePath: z.string().optional(), status: z.string(), error: z.string().optional(), imageCount: z.number().int().positive().optional(), bytes: z.number().int().nonnegative().optional(), estimatedPromptTokens: z.number().int().nonnegative().optional(), estimatedCompletionTokens: z.number().int().nonnegative().optional(), estimatedTotalTokens: z.number().int().nonnegative().optional(), usageEventSignature: z.string().optional(), expiresAt: z.string().optional() });
const ModelRewriteRuleBody = z.object({ id: z.number().int().positive().optional(), groupId: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(), fromModel: z.string(), toModel: z.string().nullable().optional(), toModels: z.array(z.string()).optional(), stickyCount: z.number().int().positive().optional(), targetWeights: z.array(z.number().int().positive()).optional() });
const ModelRewriteGroupBody = z.object({ id: z.number().int().positive().optional(), name: z.string().optional(), enabled: z.boolean().optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const ModelRewriteConfigBody = z.object({ enabled: z.boolean(), groups: z.array(ModelRewriteGroupBody).optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const FinalFallbackConfigBody = z.object({ enabled: z.boolean(), model: z.string(), models: z.array(z.string()).optional() });
const ImageProxyConfigBody = z.object({ enabled: z.boolean(), upstreamBaseUrl: z.string(), authMode: z.enum(['pass-through', 'server-key']), modelOverride: z.string().optional() });
const ModelRateLimitRuleBody = z.object({ model: z.string(), enabled: z.boolean(), rpm: z.number().positive(), queueLimit: z.number().int().nonnegative(), maxQueueWaitMs: z.number().positive() });
const ModelRateLimitConfigBody = z.object({ enabled: z.boolean(), rules: z.array(ModelRateLimitRuleBody) });
const ClientRateLimitConfigBody = z.object({ enabled: z.boolean(), rpm: z.number().positive(), concurrency: z.number().int().positive() });

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
function mutationOk(keyId: string) { return { ok: true, keyId }; }
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
function configStatus() { return buildConfigStatus(); }

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

app.register(async protectedRoutes => {
  protectedRoutes.addHook('preHandler', requireAuth);
  protectedRoutes.get('/api/config/status', async () => configStatus());
  protectedRoutes.get('/api/keys/usage', async () => usageResponse());
  protectedRoutes.get('/api/images/usage', async () => imageUsageSummary());
  protectedRoutes.get('/api/traffic/summary', async () => nineRouterLogMetrics.summary());
  protectedRoutes.post('/api/images/usage', async (req) => recordImageUsage(ImageUsageBody.parse(req.body)));
  protectedRoutes.get('/api/model-rewrite/config', async () => getModelRewriteConfig(db));
  protectedRoutes.put('/api/model-rewrite/config', async (req) => saveModelRewriteConfig(db, ModelRewriteConfigBody.parse(req.body)));
  protectedRoutes.get('/api/final-fallback/config', async () => finalFallbackStore.get());
  protectedRoutes.put('/api/final-fallback/config', async (req) => finalFallbackStore.save(FinalFallbackConfigBody.parse(req.body)));
  protectedRoutes.get('/api/model-rate-limit/config', async () => modelRateLimitStore.get());
  protectedRoutes.put('/api/model-rate-limit/config', async (req) => {
    const next = modelRateLimitStore.save(ModelRateLimitConfigBody.parse(req.body));
    modelRateLimiter.updateConfig(next);
    return next;
  });
  protectedRoutes.get('/api/client-rate-limit/config', async () => clientRateLimitStore.get());
  protectedRoutes.put('/api/client-rate-limit/config', async (req) => {
    const next = clientRateLimitStore.save(ClientRateLimitConfigBody.parse(req.body));
    clientRateLimiter.updateConfig(next);
    return next;
  });
  protectedRoutes.get('/api/image-proxy/config', async () => getImageProxyConfig(db));
  protectedRoutes.put('/api/image-proxy/config', async (req) => saveImageProxyConfig(db, ImageProxyConfigBody.parse(req.body)));
  protectedRoutes.patch('/api/keys/:keyId/policy', async (req) => {
    const { keyId } = req.params as { keyId: string };
    ensurePolicies();
    const body = PolicyPatch.parse(req.body);
    const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any;
    if (!current) {
      const err = new Error('key policy not found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    const currentMultiplier = Number(current.usage_multiplier ?? 1);
    const nextMultiplier = body.usageMultiplier === undefined ? currentMultiplier : body.usageMultiplier;
    const multiplierChanged = body.usageMultiplier !== undefined && nextMultiplier !== currentMultiplier;
    const effectiveAt = multiplierChanged ? new Date().toISOString() : current.usage_multiplier_effective_at;
    db.transaction(() => {
      db.prepare(`UPDATE key_policies SET token_limit = ?, image_daily_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(
        body.tokenLimit === undefined ? current.token_limit : body.tokenLimit,
        body.imageDailyLimit === undefined ? current.image_daily_limit : body.imageDailyLimit,
        body.windowStart ?? current.window_start,
        body.windowEnd === undefined ? current.window_end : body.windowEnd,
        body.expiresAt === undefined ? current.expires_at : body.expiresAt,
        body.resetPolicy ?? current.reset_policy,
        body.actionOnLimit ?? current.action_on_limit,
        body.notes === undefined ? current.notes : body.notes,
        nextMultiplier,
        effectiveAt,
        keyId,
      );
      if (multiplierChanged) db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run(keyId, nextMultiplier, effectiveAt);
    })();
    db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body));
    maybeUnlockQuotaAfterPolicyChange(keyId);
    apiKeyCache.invalidate();
    invalidateUsageSummaryCache();
    return mutationOk(keyId);
  });
  protectedRoutes.post('/api/keys/:keyId/reset-window', async (req, reply) => { const { keyId } = req.params as { keyId: string }; const current = db.prepare('SELECT reset_policy FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) return reply.code(404).send({ error: 'key policy not found' }); if (current.reset_policy === 'daily' || current.reset_policy === 'monthly') return reply.code(409).send({ error: `reset-window is only available for manual/custom policies; ${current.reset_policy} windows reset automatically` }); const windowStart = new Date().toISOString(); db.prepare('UPDATE key_policies SET window_start = ?, window_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart); apiKeyCache.invalidate(); invalidateUsageSummaryCache(); return mutationOk(keyId); });
  protectedRoutes.post('/api/watcher/run', async () => { const out = runWatcherOnce(db, { hardDisable: process.env.HARD_DISABLE === 'true' }); apiKeyCache.invalidate(); return out; });
  protectedRoutes.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

if (!options.disableBackgroundJobs && process.env.WATCHER_ENABLED !== 'false') startWatcher(db, Number(process.env.WATCH_INTERVAL_MS ?? 60_000), { hardDisable: process.env.HARD_DISABLE === 'true' });
if (!options.disableBackgroundJobs) nineRouterLogMetrics.start();

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => { if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' }); return reply.sendFile('index.html'); });
return app;
}
