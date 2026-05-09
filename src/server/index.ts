import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb } from './db/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readApiKeys, readUsageHistory } from './parsers/reader.js';
import { default9routerDir, dbJsonPath, usageJsonPath } from './parsers/paths.js';
import { summarizeKeyUsage } from './services/usage.js';
import { ingestUsageHistory, readStoredUsage } from './services/usageStore.js';
import { startOfVietnamDayUtc, resolveWindow, VN_TZ_LABEL } from './utils/time.js';
import { runWatcherOnce, startWatcher } from './services/watcher.js';
import { getModelRewriteConfig, saveModelRewriteConfig } from './services/modelRewrite.js';
import { applyModelRewrite } from './services/modelRewriteProxy.js';
import { TrafficLimiter, readTrafficLimitConfig } from './services/trafficLimiter.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) throw new Error('ADMIN_PASSWORD is required');
const sessionSecret = process.env.SESSION_SECRET ?? crypto.createHash('sha256').update(`${adminPassword}:dev-secret`).digest('hex');
const sessionMaxAge = Number(process.env.SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 30);
const secureCookie = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(o => o.trim()).filter(Boolean));
const nineRouterUpstream = (process.env.NINE_ROUTER_UPSTREAM ?? 'http://127.0.0.1:20128').replace(/\/$/, '');
const trafficLimiter = new TrafficLimiter(readTrafficLimitConfig(process.env));
const app = Fastify({ logger: true });
const db = openDb();
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), credentials: true });
await app.register(cookie, { secret: sessionSecret });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = process.env.WEB_ROOT ?? path.resolve(process.cwd(), 'dist/web');
if (fs.existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(), windowStart: z.string().optional(), windowEnd: z.string().nullable().optional(), expiresAt: z.string().nullable().optional(), resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(), actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(), notes: z.string().nullable().optional(), usageMultiplier: z.number().min(0).max(100).optional()
});
const LoginBody = z.object({ password: z.string() });
const PublicKeyCheckBody = z.object({ key: z.string().min(8) });
const ImageUsageBody = z.object({ kind: z.string(), model: z.string(), size: z.string().optional(), promptPreview: z.string().optional(), promptHash: z.string().optional(), inputFile: z.string().optional(), outputFile: z.string().optional(), drivePath: z.string().optional(), status: z.string(), error: z.string().optional(), imageCount: z.number().int().positive().optional(), bytes: z.number().int().nonnegative().optional() });
const ModelRewriteRuleBody = z.object({ id: z.number().int().positive().optional(), groupId: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(), fromModel: z.string(), toModel: z.string(), note: z.string().nullable().optional() });
const ModelRewriteGroupBody = z.object({ id: z.number().int().positive().optional(), name: z.string().optional(), enabled: z.boolean().optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const ModelRewriteConfigBody = z.object({ enabled: z.boolean(), groups: z.array(ModelRewriteGroupBody).optional(), rules: z.array(ModelRewriteRuleBody).optional() });

function isAuthed(req: any) { return req.unsignCookie(req.cookies?.admin_session ?? '').valid; }
async function requireAuth(req: any, reply: any) { if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' }); }

function ensurePolicies() { const keys = readApiKeys(); const defaultStart = startOfVietnamDayUtc(); const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start, reset_policy) VALUES (?, ?, ?, ?)'); for (const key of keys) insert.run(key.id, key.name, defaultStart, 'daily'); return keys; }
function resolvedPolicies() { const events = db.prepare('SELECT key_id, multiplier, effective_at FROM usage_multiplier_events ORDER BY effective_at ASC, id ASC').all() as Array<{ key_id: string; multiplier: number; effective_at: string }>; const byKey = new Map<string, Array<{ multiplier: number; effective_at: string }>>(); for (const e of events) { const arr = byKey.get(e.key_id) ?? []; arr.push({ multiplier: Number(e.multiplier), effective_at: e.effective_at }); byKey.set(e.key_id, arr); } return (db.prepare('SELECT key_id, name, window_start, window_end, reset_policy, token_limit, expires_at, action_on_limit, usage_multiplier, usage_multiplier_effective_at FROM key_policies').all() as any[]).map(p => { const w = resolveWindow({ window_start: p.window_start, window_end: p.window_end, reset_policy: p.reset_policy }); return { ...p, window_start: w.windowStart, window_end: w.windowEnd, reset_policy: w.resetPolicy, usage_multiplier_events: byKey.get(p.key_id) ?? [] }; }); }
function refreshUsageStore() { ingestUsageHistory(db, readUsageHistory()); }
function usageResponse() { const keys = ensurePolicies(); refreshUsageStore(); const usage = readStoredUsage(db); const policies = resolvedPolicies(); return summarizeKeyUsage(keys, usage, policies).sort((a, b) => { const rank = { danger: 0, expired: 1, warning: 2, unlimited: 3, ok: 4, inactive: 5 } as const; return rank[a.status] - rank[b.status] || (b.percentOfLimit ?? -1) - (a.percentOfLimit ?? -1); }); }
function imageUsageSummary() { const today = new Date(Date.now()+7*60*60*1000).toISOString().slice(0,10); const rows = db.prepare('SELECT * FROM image_usage_events ORDER BY id DESC LIMIT 200').all() as any[]; const total = db.prepare('SELECT COALESCE(SUM(image_count),0) images, COALESCE(SUM(bytes),0) bytes, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) success, SUM(CASE WHEN status!=\'success\' THEN 1 ELSE 0 END) errors FROM image_usage_events').get() as any; const todayImages = db.prepare("SELECT COALESCE(SUM(image_count),0) images FROM image_usage_events WHERE date(datetime(created_at, '+7 hours')) = ?").get(today) as any; return { todayImages: Number(todayImages.images||0), totalImages: Number(total.images||0), success: Number(total.success||0), errors: Number(total.errors||0), bytes: Number(total.bytes||0), events: rows }; }
function recordImageUsage(body:any) { db.prepare(`INSERT INTO image_usage_events (kind, model, size, prompt_preview, prompt_hash, input_file, output_file, drive_path, status, error, image_count, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(body.kind, body.model, body.size ?? null, body.promptPreview ?? null, body.promptHash ?? null, body.inputFile ?? null, body.outputFile ?? null, body.drivePath ?? null, body.status, body.error ?? null, body.imageCount ?? 1, body.bytes ?? null); return { ok: true }; }
function estimateTokens(bytes: number) { return Math.ceil(bytes / 4); }
function maskedUser(req: any) { const auth = String(req.headers?.authorization ?? ''); if (auth) return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12); return String(req.ip ?? 'unknown'); }
function configStatus() { const nineRouterDir = default9routerDir(); const dbPath = dbJsonPath(nineRouterDir); const usagePath = usageJsonPath(nineRouterDir); const errors: string[] = []; const dbJsonExists = fs.existsSync(dbPath); const usageJsonExists = fs.existsSync(usagePath); if (!dbJsonExists) errors.push(`Missing 9router db.json at ${dbPath}`); if (!usageJsonExists) errors.push(`Missing 9router usage.json at ${usagePath}`); return { ok: errors.length === 0, nineRouterDir, dbJsonPath: dbPath, usageJsonPath: usagePath, dbJsonExists, usageJsonExists, managerDbPath: process.env.KEY_MANAGER_DB ?? '~/.local/state/9router-key-manager/manager.sqlite', hardDisable: process.env.HARD_DISABLE === 'true', timezone: VN_TZ_LABEL, errors }; }

app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
app.get('/api/auth/status', async (req) => ({ authenticated: isAuthed(req) }));
app.post('/api/auth/login', async (req, reply) => { const body = LoginBody.parse(req.body); if (body.password !== adminPassword) return reply.code(401).send({ error: 'invalid password' }); reply.setCookie('admin_session', 'ok', { path: '/', signed: true, httpOnly: true, secure: secureCookie, sameSite: 'lax', maxAge: sessionMaxAge }); return { ok: true }; });
app.post('/api/auth/logout', async (_req, reply) => { reply.clearCookie('admin_session', { path: '/', secure: secureCookie, sameSite: 'lax' }); return reply.code(204).send(); });

app.post('/api/public/key-check', async (req, reply) => {
  const body = PublicKeyCheckBody.parse(req.body);
  const keys = ensurePolicies();
  const match = keys.find(k => k.key === body.key.trim());
  if (!match) return reply.code(404).send({ error: 'key not found' });
  refreshUsageStore();
  const usage = readStoredUsage(db);
  const policy = resolvedPolicies().find(p => p.key_id === match.id);
  const summary = summarizeKeyUsage([match], usage, policy ? [policy] : []).at(0);
  return summary;
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

    let body: Buffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body == null ? '' : typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const decision = applyModelRewrite(raw, req.headers['content-type'], getModelRewriteConfig(db));
      body = decision.body;
      headers.set('content-length', String(body.length));
      if (decision.rewritten) req.log.info({ fromModel: decision.fromModel, toModel: decision.toModel }, 'model rewritten');
    }

    const totalStarted = Date.now();
    const bodyBytes = body?.length ?? 0;
    const estimatedInputTokens = estimateTokens(bodyBytes);
    const model = (() => { try { return body ? JSON.parse(body.toString('utf8')).model : undefined; } catch { return undefined; } })() ?? 'unknown';
    const userId = maskedUser(req);
    const isLargeContext = estimatedInputTokens > readTrafficLimitConfig(process.env).largeContextThresholdTokens;
    let lease;
    try {
      lease = await trafficLimiter.acquire({ model, userId, estimatedInputTokens, isLargeContext });
    } catch (err: any) {
      req.log.warn({ model, userId, bodyBytes, estimatedInputTokens, errorType: 'queue_rejected', error: err?.message, limiter: trafficLimiter.snapshot() }, 'traffic limited request rejected');
      reply.header('retry-after', '10');
      return reply.code(429).send({ error: { message: 'Server busy, retry later', type: 'queue_full', retry_after: 10 } });
    }
    const upstreamStarted = Date.now();
    let releaseOnFinally = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), lease.timeoutMs);
      const upstream = await fetch(`${nineRouterUpstream}${req.raw.url}`, { method, headers, body: body as any, duplex: 'half', signal: controller.signal } as RequestInit & { duplex: 'half' });
      clearTimeout(timeout);
      const upstreamMs = Date.now() - upstreamStarted;
      req.log.info({ model, userId, bodyBytes, estimatedInputTokens, isLargeContext, queuedMs: lease.queuedMs, upstreamMs, totalMs: Date.now() - totalStarted, upstreamStatus: upstream.status, limiter: trafficLimiter.snapshot() }, 'traffic proxied request');
      reply.header('x-queue-time-ms', String(lease.queuedMs));
      reply.header('x-upstream-time-ms', String(upstreamMs));
      reply.code(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!['connection', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) reply.header(key, value);
      });
      if (!upstream.body) return reply.send();
      const stream = Readable.fromWeb(upstream.body as any);
      releaseOnFinally = false;
      stream.once('close', () => lease.release());
      stream.once('error', () => lease.release());
      stream.once('end', () => lease.release());
      return reply.send(stream);
    } catch (err: any) {
      req.log.error({ model, userId, bodyBytes, estimatedInputTokens, isLargeContext, queuedMs: lease.queuedMs, upstreamMs: Date.now() - upstreamStarted, totalMs: Date.now() - totalStarted, errorType: err?.name === 'AbortError' ? 'upstream_timeout' : 'proxy_error', error: err?.message }, 'traffic proxied request failed');
      return reply.code(err?.name === 'AbortError' ? 504 : 502).send({ error: { message: err?.name === 'AbortError' ? 'Upstream timeout' : 'Upstream proxy error', type: err?.name === 'AbortError' ? 'upstream_timeout' : 'proxy_error' } });
    } finally {
      if (releaseOnFinally) lease.release();
    }
  });
});

app.register(async protectedRoutes => {
  protectedRoutes.addHook('preHandler', requireAuth);
  protectedRoutes.get('/api/config/status', async () => configStatus());
  protectedRoutes.get('/api/keys/usage', async () => usageResponse());
  protectedRoutes.get('/api/images/usage', async () => imageUsageSummary());
  protectedRoutes.post('/api/images/usage', async (req) => recordImageUsage(ImageUsageBody.parse(req.body)));
  protectedRoutes.get('/api/model-rewrite/config', async () => getModelRewriteConfig(db));
  protectedRoutes.put('/api/model-rewrite/config', async (req) => saveModelRewriteConfig(db, ModelRewriteConfigBody.parse(req.body)));
  protectedRoutes.patch('/api/keys/:keyId/policy', async (req) => { const { keyId } = req.params as { keyId: string }; ensurePolicies(); const body = PolicyPatch.parse(req.body); const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) { const err = new Error('key policy not found') as Error & { statusCode?: number }; err.statusCode = 404; throw err; } const currentMultiplier = Number(current.usage_multiplier ?? 1); const nextMultiplier = body.usageMultiplier === undefined ? currentMultiplier : body.usageMultiplier; const multiplierChanged = body.usageMultiplier !== undefined && nextMultiplier !== currentMultiplier; const effectiveAt = multiplierChanged ? new Date().toISOString() : current.usage_multiplier_effective_at; db.transaction(() => { db.prepare(`UPDATE key_policies SET token_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(body.tokenLimit === undefined ? current.token_limit : body.tokenLimit, body.windowStart ?? current.window_start, body.windowEnd === undefined ? current.window_end : body.windowEnd, body.expiresAt === undefined ? current.expires_at : body.expiresAt, body.resetPolicy ?? current.reset_policy, body.actionOnLimit ?? current.action_on_limit, body.notes === undefined ? current.notes : body.notes, nextMultiplier, effectiveAt, keyId); if (multiplierChanged) db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run(keyId, nextMultiplier, effectiveAt); })(); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body)); return usageResponse().find(x => x.keyId === keyId); });
  protectedRoutes.post('/api/keys/:keyId/reset-window', async (req, reply) => { const { keyId } = req.params as { keyId: string }; const current = db.prepare('SELECT reset_policy FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) return reply.code(404).send({ error: 'key policy not found' }); if (current.reset_policy === 'daily' || current.reset_policy === 'monthly') return reply.code(409).send({ error: `reset-window is only available for manual/custom policies; ${current.reset_policy} windows reset automatically` }); const windowStart = new Date().toISOString(); db.prepare('UPDATE key_policies SET window_start = ?, window_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart); return usageResponse().find(x => x.keyId === keyId); });
  protectedRoutes.post('/api/watcher/run', async () => runWatcherOnce(db, { hardDisable: process.env.HARD_DISABLE === 'true' }));
  protectedRoutes.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

if (process.env.WATCHER_ENABLED !== 'false') startWatcher(db, Number(process.env.WATCH_INTERVAL_MS ?? 60_000), { hardDisable: process.env.HARD_DISABLE === 'true' });

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => { if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' }); return reply.sendFile('index.html'); });
await app.listen({ host, port });
