import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { createPublicImageStore } from '../services/publicImageStore.js';
import { registerPublicImageRoutes } from './publicImages.js';

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-public-routes-'));
  tempDirs.push(dir);
  return dir;
}

async function testApp(findPublicKey: (key: string) => { id: string; key: string } | undefined) {
  const db = new Database(':memory:');
  migrate(db);
  const publicImageStore = createPublicImageStore({ db, publicImageDir: tempDir(), publicImageTtlMs: 60_000 });
  const app = Fastify({ logger: false });
  await registerPublicImageRoutes(app, {
    db,
    findPublicKey,
    nineRouterUpstream: 'http://127.0.0.1:1',
    publicImageStore,
    queue: { maxGlobal: 1, maxPerKey: 1, ttlMs: 60_000 },
    serverImageProxyKey: () => undefined,
  });
  apps.push(app);
  return { app, publicImageStore };
}

describe('public image routes', () => {
  it('rejects image history requests with invalid public keys', async () => {
    const { app } = await testApp(() => undefined);

    const res = await app.inject({ method: 'POST', url: '/api/public/images/history', payload: { key: 'sk-invalid' } });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid key' });
  });

  it('returns current image history and downloads for the active public key', async () => {
    const key = { id: 'key-a', key: 'sk-active-key' };
    const { app, publicImageStore } = await testApp((input) => (input === key.key ? key : undefined));
    const saved = publicImageStore.savePublicImage(Buffer.from('png').toString('base64'));
    const usage = publicImageStore.recordImageUsage({ keyId: key.id, apiKey: key.key, kind: 'public-page', model: 'm', status: 'success', imageCount: 1, outputFile: saved.fileName, bytes: 3, expiresAt: saved.expiresAt });

    const history = await app.inject({ method: 'POST', url: '/api/public/images/history', payload: { key: key.key } });
    const download = await app.inject({ method: 'POST', url: '/api/public/images/download', payload: { key: key.key, id: usage.id } });

    expect(history.statusCode).toBe(200);
    expect(history.json().images).toEqual([expect.objectContaining({ id: usage.id, model: 'm', bytes: 3 })]);
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({ image: Buffer.from('png').toString('base64'), mimeType: 'image/png', filename: `gocinema-image-${usage.id}.png`, bytes: 3 });
  });
});
