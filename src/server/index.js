import Fastify from 'fastify';
import cors from '@fastify/cors';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
app.get('/api/health', async () => ({ ok: true, service: '9router-key-manager' }));
await app.listen({ host, port });
