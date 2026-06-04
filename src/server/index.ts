import 'dotenv/config';
import { createServerApp } from './app.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3039);

const app = await createServerApp();
await app.listen({ host, port });
