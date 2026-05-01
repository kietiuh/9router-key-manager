import Fastify from 'fastify';
import cors from '@fastify/cors';
import { openDb } from './db/index.js';
import { readApiKeys, readUsageHistory } from './parsers/reader.js';
import { summarizeKeyUsage, defaultWindowStart } from './services/usage.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);
const app = Fastify({ logger: true });
const db = openDb();
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));

app.get('/api/keys/usage', async () => {
  const keys = readApiKeys();
  const usage = readUsageHistory();
  const select = db.prepare('SELECT * FROM key_policies');
  const policies = select.all() as any[];
  const insert = db.prepare('INSERT OR IGNORE INTO key_policies (key_id, name, window_start) VALUES (?, ?, ?)');
  const now = defaultWindowStart();
  for (const key of keys) insert.run(key.id, key.name, now);
  const refreshed = select.all() as any[];
  return summarizeKeyUsage(keys, usage, refreshed);
});

await app.listen({ host, port });
