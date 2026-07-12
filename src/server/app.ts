import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from './db/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readApiKeys as readApiKeysFromDisk, readUsageHistorySince as readUsageHistorySinceFromDisk } from './parsers/reader.js';
import { summarizeKeyUsage } from './services/usage.js';
import { ingestUsageHistory, readStoredUsageForKeys } from './services/usageStore.js';
import { startOfVietnamDayUtc } from './utils/time.js';
import { startWatcher } from './services/watcher.js';
import { createFinalFallbackStore } from './services/finalFallback.js';
import { ModelRateLimiter } from './services/modelRateLimiter.js';
import { createModelRateLimitConfigStore } from './services/modelRateLimitConfig.js';
import { ClientRateLimiter } from './services/clientRateLimiter.js';
import { createClientRateLimitConfigStore } from './services/clientRateLimitConfig.js';
import { readUpstreamTimeoutConfig } from './services/upstreamTimeouts.js';
import { maybeUnlockQuotaLockout } from './services/quotaUnlock.js';
import { createApiKeyCache } from './services/apiKeyCache.js';
import { nineRouterLogMetrics } from './services/nineRouterLogMetrics.js';
import { resolvedPolicies as readResolvedPolicies, usageFiltersForPolicies, usageImportSince } from './services/policyUsage.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerProxyRoutes } from './routes/proxy.js';

export type ServerAppOptions = {
  adminPassword?: string;
  sessionSecret?: string;
  dbPath?: string;
  disableBackgroundJobs?: boolean;
  fetchImpl?: typeof fetch;
  readApiKeys?: typeof readApiKeysFromDisk;
  readUsageHistorySince?: typeof readUsageHistorySinceFromDisk;
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
const fetchImpl = options.fetchImpl ?? fetch;
const readApiKeys = options.readApiKeys ?? readApiKeysFromDisk;
const readUsageHistorySince = options.readUsageHistorySince ?? readUsageHistorySinceFromDisk;
const upstreamTimeoutConfig = readUpstreamTimeoutConfig(process.env);
const modelRateLimitStore = createModelRateLimitConfigStore(db);
const modelRateLimiter = new ModelRateLimiter(modelRateLimitStore.get());
const clientRateLimitStore = createClientRateLimitConfigStore(db);
const clientRateLimiter = new ClientRateLimiter(clientRateLimitStore.get());
const includeLimiterInSuccessLogs = process.env.TRAFFIC_LOG_LIMITER_SNAPSHOT === 'true';
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
  const policies = readResolvedPolicies(db, { imageDailyUsageForKey: () => 0 });
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
  const policies = readResolvedPolicies(db, { imageDailyUsageForKey: () => 0 });
  const policy = policies.find(p => p.key_id === keyId);
  const usage = readStoredUsageForKeys(db, [{ apiKey: key.key, sinceIso: policy?.window_start }]);
  const summary = summarizeKeyUsage([key], usage, policy ? [policy] : []).at(0);
  if (!summary) return;
  const unlock = maybeUnlockQuotaLockout(db, summary, { hardDisable: process.env.HARD_DISABLE === 'true' });
  if (unlock.unlocked) app.log.info({ keyId, enableChanged: unlock.enableResult?.changed ?? false }, 'quota lockout cleared after policy update');
}

function findPublicKeyAny(key: string) { const clean = key.trim(); return apiKeyCache.getKeys().find(k => k.key === clean); }
function autoDisabledReason(keyId: string): string | null {
  const row = db.prepare('SELECT reason FROM auto_disabled_keys WHERE key_id = ? ORDER BY disabled_for_window_start DESC LIMIT 1').get(keyId) as { reason?: string } | undefined;
  return row?.reason ?? null;
}
function lastDisableAuditMessage(keyId: string): string | null {
  const row = db.prepare("SELECT message FROM audit_log WHERE key_id = ? AND action IN ('disable','auto.disable') ORDER BY id DESC LIMIT 1").get(keyId) as { message?: string } | undefined;
  return row?.message ?? null;
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
  const policy = readResolvedPolicies(db, { imageDailyUsageForKey: () => 0 }).find(p => p.key_id === match.id);
  const usage = readStoredUsageForKeys(db, [{ apiKey: match.key, sinceIso: policy?.window_start }]);
  const summary = summarizeKeyUsage([match], usage, policy ? [policy] : []).at(0);
  if (!summary) return reply.code(404).send({ error: 'key not found' });
  if (!match.isActive) {
    const reason = autoDisabledReason(match.id) ?? lastDisableAuditMessage(match.id);
    if (reason) summary.statusReason = reason;
  }
  const { modelUsage: _modelUsage, models: _models, allowedModels: _allowedModels, ...publicSummary } = summary;
  return publicSummary;
});

await registerProxyRoutes(app, {
  db,
  nineRouterUpstream,
  upstreamTimeoutConfig,
  finalFallbackStore,
  modelRateLimiter,
  clientRateLimiter,
  lookupKey: token => apiKeyCache.lookup(token),
  includeLimiterInSuccessLogs,
  fetchImpl,
});

await registerAdminRoutes(app, {
  db,
  requireAuth,
  usageResponse,
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

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => {
  const pathname = (req.raw.url ?? '').split('?')[0] ?? '';
  if (pathname === '/images' || pathname === '/image' || pathname.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});
return app;
}
