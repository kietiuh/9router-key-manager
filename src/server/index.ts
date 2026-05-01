import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { openDb } from './db/index.js';
import { readApiKeys, readUsageHistory } from './parsers/reader.js';
import { summarizeKeyUsage } from './services/usage.js';
import { runWatcherOnce } from './services/watcher.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);
const app = Fastify({ logger: true });
const db = openDb();
await app.register(cors, { origin: true });

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(),
  actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(),
  notes: z.string().nullable().optional()
});

function ensurePolicies() {
  const keys = readApiKeys();
  const usage = readUsageHistory();
  const firstUsage = usage.reduce<string | null>((min, r) => !min || r.timestamp < min ? r.timestamp : min, null);
  const defaultStart = firstUsage ?? '1970-01-01T00:00:00.000Z';
  const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start) VALUES (?, ?, ?)');
  for (const key of keys) insert.run(key.id, key.name, defaultStart);
  return keys;
}

function usageResponse() {
  const keys = ensurePolicies();
  const usage = readUsageHistory();
  const policies = db.prepare('SELECT key_id, name, window_start, window_end, token_limit, expires_at, action_on_limit FROM key_policies').all() as any[];
  return summarizeKeyUsage(keys, usage, policies);
}

app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
app.get('/api/keys/usage', async () => usageResponse());

app.patch('/api/keys/:keyId/policy', async (req) => {
  const { keyId } = req.params as { keyId: string };
  ensurePolicies();
  const body = PolicyPatch.parse(req.body);
  const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any;
  if (!current) { const err = new Error('key policy not found') as Error & { statusCode?: number }; err.statusCode = 404; throw err; }
  db.prepare(`UPDATE key_policies SET
    token_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE key_id = ?`).run(
      body.tokenLimit === undefined ? current.token_limit : body.tokenLimit,
      body.windowStart ?? current.window_start,
      body.windowEnd === undefined ? current.window_end : body.windowEnd,
      body.expiresAt === undefined ? current.expires_at : body.expiresAt,
      body.resetPolicy ?? current.reset_policy,
      body.actionOnLimit ?? current.action_on_limit,
      body.notes === undefined ? current.notes : body.notes,
      keyId
    );
  db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body));
  return usageResponse().find(x => x.keyId === keyId);
});

app.post('/api/keys/:keyId/reset-window', async (req) => {
  const { keyId } = req.params as { keyId: string };
  const windowStart = new Date().toISOString();
  db.prepare('UPDATE key_policies SET window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId);
  db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart);
  return usageResponse().find(x => x.keyId === keyId);
});

app.post('/api/watcher/run', async () => runWatcherOnce(db, { hardDisable: process.env.HARD_DISABLE === 'true' }));

app.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());

await app.listen({ host, port });
