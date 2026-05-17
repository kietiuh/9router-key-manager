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
import { readApiKeys, readUsageHistory, usageSourceStatus } from './parsers/reader.js';
import { default9routerDir, dbJsonPath, usageJsonPath } from './parsers/paths.js';
import { summarizeKeyUsage } from './services/usage.js';
import { ingestUsageHistory, readStoredUsage } from './services/usageStore.js';
import { startOfVietnamDayUtc, resolveWindow, VN_TZ_LABEL } from './utils/time.js';
import { runWatcherOnce, startWatcher } from './services/watcher.js';
import { getModelRewriteConfig, rollbackModelRewriteSelection, saveModelRewriteConfig, selectModelRewriteTargets, type RewriteTargetPlan } from './services/modelRewrite.js';
import { applyRewritePlan, parseModelRewriteRequest } from './services/modelRewriteProxy.js';
import { createFinalFallbackStore } from './services/finalFallback.js';
import { fetchUpstreamWithFailover, ProxyFailoverError, TrafficAcquireError } from './services/proxyFailover.js';
import { TrafficLimiter, readTrafficLimitConfig, type TrafficLease } from './services/trafficLimiter.js';
import { buildImageProxyUrl, getImageProxyConfig, isImageProxyPath, maybeRewriteImageModel, parseImageUsage, saveImageProxyConfig } from './services/imageProxy.js';
import { imageProxyNeedsServerKey } from '../shared/imageProxy.js';

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
const finalFallbackStore = createFinalFallbackStore(db);
await app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)), credentials: true });
await app.register(cookie, { secret: sessionSecret });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = process.env.WEB_ROOT ?? path.resolve(process.cwd(), 'dist/web');
if (fs.existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(), windowStart: z.string().optional(), windowEnd: z.string().nullable().optional(), expiresAt: z.string().nullable().optional(), resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(), actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(), notes: z.string().nullable().optional(), usageMultiplier: z.number().min(0).max(100).optional()
});
const LoginBody = z.object({ password: z.string() });
const PublicKeyCheckBody = z.object({ key: z.string().min(8) });
const PublicImageOptimizeBody = z.object({ key: z.string().min(8), prompt: z.string().min(3).max(6000) });
const PublicImageGenerateBody = z.object({ key: z.string().min(8), prompt: z.string().min(3).max(6000), size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional() });
const ImageUsageBody = z.object({ kind: z.string(), model: z.string(), size: z.string().optional(), promptPreview: z.string().optional(), promptHash: z.string().optional(), inputFile: z.string().optional(), outputFile: z.string().optional(), drivePath: z.string().optional(), status: z.string(), error: z.string().optional(), imageCount: z.number().int().positive().optional(), bytes: z.number().int().nonnegative().optional() });
const ModelRewriteRuleBody = z.object({ id: z.number().int().positive().optional(), groupId: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(), fromModel: z.string(), toModel: z.string().nullable().optional(), toModels: z.array(z.string()).optional(), stickyCount: z.number().int().positive().optional() });
const ModelRewriteGroupBody = z.object({ id: z.number().int().positive().optional(), name: z.string().optional(), enabled: z.boolean().optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const ModelRewriteConfigBody = z.object({ enabled: z.boolean(), groups: z.array(ModelRewriteGroupBody).optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const FinalFallbackConfigBody = z.object({ enabled: z.boolean(), model: z.string() });
const ImageProxyConfigBody = z.object({ enabled: z.boolean(), upstreamBaseUrl: z.string(), authMode: z.enum(['pass-through', 'server-key']), modelOverride: z.string().optional() });

function isAuthed(req: any) { return req.unsignCookie(req.cookies?.admin_session ?? '').valid; }
async function requireAuth(req: any, reply: any) { if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' }); }

function ensurePolicies() { const keys = readApiKeys(); const defaultStart = startOfVietnamDayUtc(); const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start, reset_policy) VALUES (?, ?, ?, ?)'); for (const key of keys) insert.run(key.id, key.name, defaultStart, 'daily'); return keys; }
function resolvedPolicies() { const events = db.prepare('SELECT key_id, multiplier, effective_at FROM usage_multiplier_events ORDER BY effective_at ASC, id ASC').all() as Array<{ key_id: string; multiplier: number; effective_at: string }>; const byKey = new Map<string, Array<{ multiplier: number; effective_at: string }>>(); for (const e of events) { const arr = byKey.get(e.key_id) ?? []; arr.push({ multiplier: Number(e.multiplier), effective_at: e.effective_at }); byKey.set(e.key_id, arr); } return (db.prepare('SELECT key_id, name, window_start, window_end, reset_policy, token_limit, expires_at, action_on_limit, usage_multiplier, usage_multiplier_effective_at FROM key_policies').all() as any[]).map(p => { const w = resolveWindow({ window_start: p.window_start, window_end: p.window_end, reset_policy: p.reset_policy }); return { ...p, window_start: w.windowStart, window_end: w.windowEnd, reset_policy: w.resetPolicy, usage_multiplier_events: byKey.get(p.key_id) ?? [] }; }); }
function refreshUsageStore() { ingestUsageHistory(db, readUsageHistory()); }
function usageResponse() { const keys = ensurePolicies(); refreshUsageStore(); const usage = readStoredUsage(db); const policies = resolvedPolicies(); return summarizeKeyUsage(keys, usage, policies).sort((a, b) => { const rank = { danger: 0, expired: 1, warning: 2, unlimited: 3, ok: 4, inactive: 5 } as const; return rank[a.status] - rank[b.status] || (Date.parse(b.lastUsageAt ?? '') || 0) - (Date.parse(a.lastUsageAt ?? '') || 0) || (b.percentOfLimit ?? -1) - (a.percentOfLimit ?? -1); }); }
function imageUsageSummary() { const today = new Date(Date.now()+7*60*60*1000).toISOString().slice(0,10); const rows = db.prepare('SELECT * FROM image_usage_events ORDER BY id DESC LIMIT 200').all() as any[]; const total = db.prepare('SELECT COALESCE(SUM(image_count),0) images, COALESCE(SUM(bytes),0) bytes, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) success, SUM(CASE WHEN status!=\'success\' THEN 1 ELSE 0 END) errors FROM image_usage_events').get() as any; const todayImages = db.prepare("SELECT COALESCE(SUM(image_count),0) images FROM image_usage_events WHERE date(datetime(created_at, '+7 hours')) = ?").get(today) as any; return { todayImages: Number(todayImages.images||0), totalImages: Number(total.images||0), success: Number(total.success||0), errors: Number(total.errors||0), bytes: Number(total.bytes||0), events: rows }; }
function recordImageUsage(body:any) { db.prepare(`INSERT INTO image_usage_events (kind, model, size, prompt_preview, prompt_hash, input_file, output_file, drive_path, status, error, image_count, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(body.kind, body.model, body.size ?? null, body.promptPreview ?? null, body.promptHash ?? null, body.inputFile ?? null, body.outputFile ?? null, body.drivePath ?? null, body.status, body.error ?? null, body.imageCount ?? 1, body.bytes ?? null); return { ok: true }; }
function recordImageProxyUsage(body:any) { try { recordImageUsage(body); } catch { /* usage logging must not break proxy */ } }
function findPublicKey(key: string) { const clean = key.trim(); return ensurePolicies().find(k => k.key === clean && k.isActive !== false); }
function sanitizeImagePrompt(prompt: string) { return prompt.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000); }
function guardImagePrompt(prompt: string) {
  const text = sanitizeImagePrompt(prompt);
  const lower = text.toLowerCase();
  const blocked = [/child\s*(sexual|nude|porn|explicit)/i, /loli|shota/i, /underage.*(nude|sex|porn)/i, /realistic\s+gore/i, /blood\s+and\s+guts/i];
  if (!text) throw new Error('Prompt is empty');
  if (blocked.some(rx => rx.test(lower))) throw new Error('Prompt is not allowed');
  return text;
}
function fallbackOptimizedPrompt(prompt: string) {
  const clean = guardImagePrompt(prompt);
  return `${clean}, high quality, coherent composition, sharp focus, detailed lighting, cinematic color grading, polished digital art, no text, no watermark, no distorted hands, no extra fingers, no blurry face`;
}
function extractChatContent(json: any) { return String(json?.choices?.[0]?.message?.content ?? json?.output_text ?? '').trim(); }
function extractChatStreamContent(text: string) {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try { out += JSON.parse(data)?.choices?.[0]?.delta?.content ?? ''; } catch { /* ignore bad SSE chunks */ }
  }
  return out.trim();
}
function extractImageBase64(json: any) {
  const item = json?.data?.[0];
  if (typeof item?.b64_json === 'string') return { image: item.b64_json, revisedPrompt: item.revised_prompt ?? item.revisedPrompt };
  if (typeof item?.url === 'string' && item.url.startsWith('data:image/')) return { image: item.url.split(',').pop() || '', revisedPrompt: item.revised_prompt ?? item.revisedPrompt };
  return { image: '', revisedPrompt: undefined };
}
function publicImageFilename() { return `gocinema-image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`; }
function maskedUser(req: any) { const auth = String(req.headers?.authorization ?? ''); if (auth) return crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12); return String(req.ip ?? 'unknown'); }
function configStatus() { const nineRouterDir = default9routerDir(); const dbPath = dbJsonPath(nineRouterDir); const usagePath = usageJsonPath(nineRouterDir); const errors: string[] = []; const dbJsonExists = fs.existsSync(dbPath); const usageJsonExists = fs.existsSync(usagePath); const source = usageSourceStatus(nineRouterDir); if (!dbJsonExists) errors.push(`Missing 9router db.json at ${dbPath}`); if (!usageJsonExists) errors.push(`Missing 9router usage.json at ${usagePath}`); return { ok: errors.length === 0, nineRouterDir, dbJsonPath: dbPath, usageJsonPath: usagePath, dataSqlitePath: source.dataSqlitePath, usageSource: source.usageSource, dbJsonExists, usageJsonExists, dataSqliteExists: source.dataSqliteExists, managerDbPath: process.env.KEY_MANAGER_DB ?? '~/.local/state/9router-key-manager/manager.sqlite', hardDisable: process.env.HARD_DISABLE === 'true', timezone: VN_TZ_LABEL, errors }; }

app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
app.get('/api/auth/status', async (req) => ({ authenticated: isAuthed(req) }));
app.post('/api/auth/login', async (req, reply) => { const body = LoginBody.parse(req.body); if (body.password !== adminPassword) return reply.code(401).send({ error: 'invalid password' }); reply.setCookie('admin_session', 'ok', { path: '/', signed: true, httpOnly: true, secure: secureCookie, sameSite: 'lax', maxAge: sessionMaxAge }); return { ok: true }; });
app.post('/api/auth/logout', async (_req, reply) => { reply.clearCookie('admin_session', { path: '/', secure: secureCookie, sameSite: 'lax' }); return reply.code(204).send(); });

app.post('/api/public/key-check', async (req, reply) => {
  const body = PublicKeyCheckBody.parse(req.body);
  const match = findPublicKey(body.key);
  if (!match) return reply.code(404).send({ error: 'key not found' });
  refreshUsageStore();
  const usage = readStoredUsage(db);
  const policy = resolvedPolicies().find(p => p.key_id === match.id);
  const summary = summarizeKeyUsage([match], usage, policy ? [policy] : []).at(0);
  if (!summary) return reply.code(404).send({ error: 'key not found' });
  const { modelUsage: _modelUsage, models: _models, ...publicSummary } = summary;
  return publicSummary;
});

app.post('/api/public/images/optimize-prompt', async (req, reply) => {
  const body = PublicImageOptimizeBody.parse(req.body);
  const match = findPublicKey(body.key);
  if (!match) return reply.code(401).send({ error: 'invalid key' });
  const prompt = guardImagePrompt(body.prompt);
  const system = 'Rewrite image prompts for a text-to-image model. Return only the improved prompt in English. Keep user intent. Add concise visual details: subject, composition, lighting, style, quality. Avoid unsafe sexual minors, gore, hate, private data, text/watermarks.';
  try {
    const upstream = await fetch(`${nineRouterUpstream}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${match.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'v1/cx/gpt-5.5', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: true, max_tokens: 500 }),
    });
    const text = await upstream.text();
    let optimized = extractChatStreamContent(text);
    if (!optimized) {
      try { optimized = extractChatContent(JSON.parse(text)); } catch { /* non-json fallback */ }
    }
    optimized = sanitizeImagePrompt(optimized);
    if (upstream.ok && optimized) return { prompt: guardImagePrompt(optimized), source: 'optimized' };
  } catch { /* fallback below */ }
  return { prompt: fallbackOptimizedPrompt(prompt), source: 'fallback' };
});

app.post('/api/public/images/generate', async (req, reply) => {
  const body = PublicImageGenerateBody.parse(req.body);
  const match = findPublicKey(body.key);
  if (!match) return reply.code(401).send({ error: 'invalid key' });
  const prompt = guardImagePrompt(body.prompt);
  const size = body.size ?? '1024x1024';
  const imageProxyConfig = getImageProxyConfig(db);
  if (!imageProxyConfig.enabled) return reply.code(503).send({ error: 'image proxy disabled' });
  const upstreamHeaders: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${match.key}` };
  if (imageProxyNeedsServerKey(imageProxyConfig)) {
    const serverKey = process.env.IMAGE_PROXY_API_KEY;
    if (!serverKey) return reply.code(503).send({ error: 'image service not configured' });
    upstreamHeaders.authorization = `Bearer ${serverKey}`;
  }
  const imageModel = imageProxyConfig.modelOverride?.trim() || 'cx/gpt-5.4-image';
  const payload = { model: imageModel, prompt: fallbackOptimizedPrompt(prompt), size, n: 1 };
  const started = Date.now();
  try {
    const upstream = await fetch(buildImageProxyUrl(imageProxyConfig, '/v1/images/generations'), { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(payload) });
    const json = await upstream.json().catch(() => ({}));
    const { image, revisedPrompt } = extractImageBase64(json);
    if (!upstream.ok || !image) {
      recordImageProxyUsage({ kind: 'public-page', model: imageModel, size, promptPreview: prompt.slice(0, 160), status: 'error', error: json?.error?.message || `upstream ${upstream.status}`, imageCount: 1 });
      return reply.code(upstream.ok ? 502 : upstream.status).send({ error: json?.error?.message || 'image generation failed' });
    }
    const bytes = Buffer.byteLength(image, 'base64');
    recordImageProxyUsage({ kind: 'public-page', model: imageModel, size, promptPreview: prompt.slice(0, 160), promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16), status: 'success', imageCount: 1, bytes });
    req.log.info({ keyId: match.id, model: imageModel, size, bytes, totalMs: Date.now() - started }, 'public image generated');
    return { image, mimeType: 'image/png', filename: publicImageFilename(), revisedPrompt, prompt: payload.prompt, bytes };
  } catch (err: any) {
    recordImageProxyUsage({ kind: 'public-page', model: imageModel, size, promptPreview: prompt.slice(0, 160), status: 'error', error: err?.message, imageCount: 1 });
    return reply.code(502).send({ error: 'image upstream error' });
  }
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
    const imageProxyConfig = getImageProxyConfig(db);
    if (imageProxyConfig.enabled && isImageProxyPath(req.raw.url?.split('?')[0] ?? '') && method !== 'GET' && method !== 'HEAD') {
      if (imageProxyNeedsServerKey(imageProxyConfig)) {
        const serverKey = process.env.IMAGE_PROXY_API_KEY;
        if (!serverKey) return reply.code(503).send({ error: { message: 'Image proxy server key is not configured', type: 'image_proxy_config' } });
        headers.set('authorization', `Bearer ${serverKey}`);
      }
      const body = maybeRewriteImageModel(rawBody, req.headers['content-type'], imageProxyConfig.modelOverride);
      if (body) headers.set('content-length', String(body.length));
      else headers.delete('content-length');
      const totalStarted = Date.now();
      const upstreamStarted = Date.now();
      try {
        const upstream = await fetch(buildImageProxyUrl(imageProxyConfig, req.raw.url ?? '/v1/images/generations'), { method, headers, body: body as any, duplex: 'half' } as RequestInit & { duplex: 'half' });
        const upstreamMs = Date.now() - upstreamStarted;
        const responseBuffer = Buffer.from(await upstream.arrayBuffer());
        const usage = parseImageUsage(body, responseBuffer.length, upstream.status);
        recordImageProxyUsage(usage);
        req.log.info({ upstreamBaseUrl: imageProxyConfig.upstreamBaseUrl, upstreamStatus: upstream.status, upstreamMs, totalMs: Date.now() - totalStarted, bodyBytes: body?.length ?? 0, responseBytes: responseBuffer.length }, 'image request proxied direct');
        reply.header('x-image-proxy', 'direct');
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
    const largeContextThresholdTokens = readTrafficLimitConfig(process.env).largeContextThresholdTokens;
    let lease: TrafficLease | undefined;
    let result;
    let releaseOnFinally = true;
    try {
      result = await fetchUpstreamWithFailover({
        upstreamUrl: `${nineRouterUpstream}${req.raw.url}`,
        method,
        headers,
        decision,
        finalFallback: finalFallbackStore.get(),
        userId,
        largeContextThresholdTokens,
        trafficLimiter,
        log: (data, message) => req.log.info(data, message),
      });
      lease = result.lease;
      req.log.info({ model: result.model, userId, bodyBytes: result.bodyBytes, estimatedInputTokens: result.estimatedInputTokens, isLargeContext: result.isLargeContext, queuedMs: result.queuedMs, upstreamMs: result.upstreamMs, totalMs: Date.now() - totalStarted, upstreamStatus: result.upstream.status, attemptIndex: result.attemptIndex, attemptCount: result.attemptCount, limiter: trafficLimiter.snapshot() }, 'traffic proxied request');
      reply.header('x-queue-time-ms', String(result.queuedMs));
      reply.header('x-upstream-time-ms', String(result.upstreamMs));
      reply.code(result.upstream.status);
      result.upstream.headers.forEach((value, key) => {
        if (!['connection', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) reply.header(key, value);
      });
      if (!result.upstream.body) return reply.send();
      const stream = Readable.fromWeb(result.upstream.body as any);
      const streamLease = result.lease;
      releaseOnFinally = false;
      let streamLeaseReleased = false;
      const releaseStreamLease = () => {
        if (streamLeaseReleased) return;
        streamLeaseReleased = true;
        streamLease.release();
      };
      stream.once('close', releaseStreamLease);
      stream.once('error', releaseStreamLease);
      stream.once('end', releaseStreamLease);
      return reply.send(stream);
    } catch (err: any) {
      if (err instanceof TrafficAcquireError) {
        if (err.attemptIndex === 0 && rewritePlan) rollbackModelRewriteSelection(db, rewritePlan);
        req.log.warn({ model: err.model, userId, errorType: 'queue_rejected', error: err.message, limiter: err.snapshot }, 'traffic limited request rejected');
        reply.header('retry-after', String(err.retryAfter));
        return reply.code(err.statusCode).send({ error: { message: 'Server busy, retry later', type: err.type, retry_after: err.retryAfter } });
      }
      if (err instanceof ProxyFailoverError) {
        req.log.error({ model: err.model, userId, totalMs: Date.now() - totalStarted, errorType: err.type, error: err.message }, 'traffic proxied request failed');
        return reply.code(err.statusCode).send({ error: { message: err.message, type: err.type } });
      }
      req.log.error({ userId, totalMs: Date.now() - totalStarted, errorType: 'proxy_error', error: err?.message }, 'traffic proxied request failed');
      return reply.code(502).send({ error: { message: 'Upstream proxy error', type: 'proxy_error' } });
    } finally {
      if (releaseOnFinally) lease?.release();
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
  protectedRoutes.get('/api/final-fallback/config', async () => finalFallbackStore.get());
  protectedRoutes.put('/api/final-fallback/config', async (req) => finalFallbackStore.save(FinalFallbackConfigBody.parse(req.body)));
  protectedRoutes.get('/api/image-proxy/config', async () => getImageProxyConfig(db));
  protectedRoutes.put('/api/image-proxy/config', async (req) => saveImageProxyConfig(db, ImageProxyConfigBody.parse(req.body)));
  protectedRoutes.patch('/api/keys/:keyId/policy', async (req) => { const { keyId } = req.params as { keyId: string }; ensurePolicies(); const body = PolicyPatch.parse(req.body); const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) { const err = new Error('key policy not found') as Error & { statusCode?: number }; err.statusCode = 404; throw err; } const currentMultiplier = Number(current.usage_multiplier ?? 1); const nextMultiplier = body.usageMultiplier === undefined ? currentMultiplier : body.usageMultiplier; const multiplierChanged = body.usageMultiplier !== undefined && nextMultiplier !== currentMultiplier; const effectiveAt = multiplierChanged ? new Date().toISOString() : current.usage_multiplier_effective_at; db.transaction(() => { db.prepare(`UPDATE key_policies SET token_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(body.tokenLimit === undefined ? current.token_limit : body.tokenLimit, body.windowStart ?? current.window_start, body.windowEnd === undefined ? current.window_end : body.windowEnd, body.expiresAt === undefined ? current.expires_at : body.expiresAt, body.resetPolicy ?? current.reset_policy, body.actionOnLimit ?? current.action_on_limit, body.notes === undefined ? current.notes : body.notes, nextMultiplier, effectiveAt, keyId); if (multiplierChanged) db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run(keyId, nextMultiplier, effectiveAt); })(); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body)); return usageResponse().find(x => x.keyId === keyId); });
  protectedRoutes.post('/api/keys/:keyId/reset-window', async (req, reply) => { const { keyId } = req.params as { keyId: string }; const current = db.prepare('SELECT reset_policy FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) return reply.code(404).send({ error: 'key policy not found' }); if (current.reset_policy === 'daily' || current.reset_policy === 'monthly') return reply.code(409).send({ error: `reset-window is only available for manual/custom policies; ${current.reset_policy} windows reset automatically` }); const windowStart = new Date().toISOString(); db.prepare('UPDATE key_policies SET window_start = ?, window_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart); return usageResponse().find(x => x.keyId === keyId); });
  protectedRoutes.post('/api/watcher/run', async () => runWatcherOnce(db, { hardDisable: process.env.HARD_DISABLE === 'true' }));
  protectedRoutes.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

if (process.env.WATCHER_ENABLED !== 'false') startWatcher(db, Number(process.env.WATCH_INTERVAL_MS ?? 60_000), { hardDisable: process.env.HARD_DISABLE === 'true' });

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => { if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' }); return reply.sendFile('index.html'); });
await app.listen({ host, port });
