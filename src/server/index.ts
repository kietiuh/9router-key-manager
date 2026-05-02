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
import { readApiKeys, readUsageHistory } from './parsers/reader.js';
import { default9routerDir, dbJsonPath, usageJsonPath } from './parsers/paths.js';
import { summarizeKeyUsage } from './services/usage.js';
import { startOfVietnamDayUtc, resolveWindow, VN_TZ_LABEL } from './utils/time.js';
import { runWatcherOnce, startWatcher } from './services/watcher.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);
const adminPassword = process.env.ADMIN_PASSWORD ?? 'levuphong';
const sessionSecret = process.env.SESSION_SECRET ?? crypto.createHash('sha256').update(`${adminPassword}:dev-secret`).digest('hex');
const sessionMaxAge = Number(process.env.SESSION_MAX_AGE_SECONDS ?? 60 * 60 * 24 * 30);
const app = Fastify({ logger: true });
const db = openDb();
await app.register(cors, { origin: true });
await app.register(cookie, { secret: sessionSecret });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = process.env.WEB_ROOT ?? path.resolve(process.cwd(), 'dist/web');
if (fs.existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(), windowStart: z.string().optional(), windowEnd: z.string().nullable().optional(), expiresAt: z.string().nullable().optional(), resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(), actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(), notes: z.string().nullable().optional()
});
const LoginBody = z.object({ password: z.string() });
const PublicKeyCheckBody = z.object({ key: z.string().min(8) });

function isAuthed(req: any) { return req.unsignCookie(req.cookies?.admin_session ?? '').valid; }
function requireAuth(req: any, reply: any, done: any) { if (isAuthed(req)) return done(); reply.code(401).send({ error: 'unauthorized' }); }

function ensurePolicies() { const keys = readApiKeys(); const defaultStart = startOfVietnamDayUtc(); const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start, reset_policy) VALUES (?, ?, ?, ?)'); for (const key of keys) insert.run(key.id, key.name, defaultStart, 'daily'); return keys; }
function resolvedPolicies() { return (db.prepare('SELECT key_id, name, window_start, window_end, reset_policy, token_limit, expires_at, action_on_limit FROM key_policies').all() as any[]).map(p => { const w = resolveWindow({ window_start: p.window_start, window_end: p.window_end, reset_policy: p.reset_policy }); return { ...p, window_start: w.windowStart, window_end: w.windowEnd, reset_policy: w.resetPolicy }; }); }
function usageResponse() { const keys = ensurePolicies(); const usage = readUsageHistory(); const policies = resolvedPolicies(); return summarizeKeyUsage(keys, usage, policies).sort((a, b) => { const rank = { danger: 0, expired: 1, warning: 2, unlimited: 3, ok: 4, inactive: 5 } as const; return rank[a.status] - rank[b.status] || (b.percentOfLimit ?? -1) - (a.percentOfLimit ?? -1); }); }
function configStatus() { const nineRouterDir = default9routerDir(); const dbPath = dbJsonPath(nineRouterDir); const usagePath = usageJsonPath(nineRouterDir); const errors: string[] = []; const dbJsonExists = fs.existsSync(dbPath); const usageJsonExists = fs.existsSync(usagePath); if (!dbJsonExists) errors.push(`Missing 9router db.json at ${dbPath}`); if (!usageJsonExists) errors.push(`Missing 9router usage.json at ${usagePath}`); return { ok: errors.length === 0, nineRouterDir, dbJsonPath: dbPath, usageJsonPath: usagePath, dbJsonExists, usageJsonExists, managerDbPath: process.env.KEY_MANAGER_DB ?? '~/.local/state/9router-key-manager/manager.sqlite', hardDisable: process.env.HARD_DISABLE === 'true', timezone: VN_TZ_LABEL, errors }; }

app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
app.get('/api/auth/status', async (req) => ({ authenticated: isAuthed(req) }));
app.post('/api/auth/login', async (req, reply) => { const body = LoginBody.parse(req.body); if (body.password !== adminPassword) return reply.code(401).send({ error: 'invalid password' }); reply.setCookie('admin_session', 'ok', { path: '/', signed: true, httpOnly: true, secure: true, sameSite: 'lax', maxAge: sessionMaxAge }); return { ok: true }; });
app.post('/api/auth/logout', async (_req, reply) => { reply.clearCookie('admin_session', { path: '/' }); return { ok: true }; });

app.post('/api/public/key-check', async (req, reply) => {
  const body = PublicKeyCheckBody.parse(req.body);
  const keys = ensurePolicies();
  const match = keys.find(k => k.key === body.key.trim());
  if (!match) return reply.code(404).send({ error: 'key not found' });
  const usage = readUsageHistory();
  const policy = resolvedPolicies().find(p => p.key_id === match.id);
  const summary = summarizeKeyUsage([match], usage, policy ? [policy] : []).at(0);
  return summary;
});

app.get('/api/config/status', async () => configStatus());
  app.get('/api/keys/usage', async () => usageResponse());
  app.patch('/api/keys/:keyId/policy', async (req) => { const { keyId } = req.params as { keyId: string }; ensurePolicies(); const body = PolicyPatch.parse(req.body); const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any; if (!current) { const err = new Error('key policy not found') as Error & { statusCode?: number }; err.statusCode = 404; throw err; } db.prepare(`UPDATE key_policies SET token_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(body.tokenLimit === undefined ? current.token_limit : body.tokenLimit, body.windowStart ?? current.window_start, body.windowEnd === undefined ? current.window_end : body.windowEnd, body.expiresAt === undefined ? current.expires_at : body.expiresAt, body.resetPolicy ?? current.reset_policy, body.actionOnLimit ?? current.action_on_limit, body.notes === undefined ? current.notes : body.notes, keyId); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body)); return usageResponse().find(x => x.keyId === keyId); });
  app.post('/api/keys/:keyId/reset-window', async (req) => { const { keyId } = req.params as { keyId: string }; const windowStart = startOfVietnamDayUtc(); db.prepare('UPDATE key_policies SET window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId); db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart); return usageResponse().find(x => x.keyId === keyId); });
  app.post('/api/watcher/run', async () => runWatcherOnce(db, { hardDisable: process.env.HARD_DISABLE === 'true' }));
  app.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());

if (process.env.WATCHER_ENABLED !== 'false') startWatcher(db, Number(process.env.WATCH_INTERVAL_MS ?? 60_000), { hardDisable: process.env.HARD_DISABLE === 'true' });

if (fs.existsSync(webRoot)) app.setNotFoundHandler(async (req, reply) => { if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' }); return reply.sendFile('index.html'); });
await app.listen({ host, port });
