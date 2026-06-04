import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerApp } from './app.js';

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.map(app => app.close()));
  apps.length = 0;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-app-'));
  tempDirs.push(dir);
  return path.join(dir, 'manager.sqlite');
}

async function app() {
  const dbPath = tempDbPath();
  const instance = await createServerApp({
    adminPassword: 'test-password',
    disableBackgroundJobs: true,
    dbPath,
  });
  apps.push(instance);
  return { instance, dbPath };
}

async function adminCookie(server: FastifyInstance) {
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'test-password' },
  });
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : cookie;
}

describe('server app routes', () => {
  it('serves health without auth', async () => {
    const { instance: server } = await app();

    const res = await server.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: '9router-key-manager' });
  });

  it('rejects protected routes without auth', async () => {
    const { instance: server } = await app();

    const res = await server.inject({ method: 'GET', url: '/api/keys/usage' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('sets signed admin session cookie on login', async () => {
    const { instance: server } = await app();

    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'test-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(expect.stringContaining('admin_session='));
  });

  it('rejects admin config routes without auth', async () => {
    const { instance: server } = await app();

    const res = await server.inject({ method: 'GET', url: '/api/config/status' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns default client rate limit config for authenticated admins', async () => {
    const { instance: server } = await app();
    const cookie = await adminCookie(server);

    const res = await server.inject({ method: 'GET', url: '/api/client-rate-limit/config', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, rpm: 30, concurrency: 5 });
  });

  it('returns default model rate limit config for authenticated admins', async () => {
    const { instance: server } = await app();
    const cookie = await adminCookie(server);

    const res = await server.inject({ method: 'GET', url: '/api/model-rate-limit/config', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, rules: [] });
  });

  it('uses the injected manager database path', async () => {
    const { dbPath } = await app();

    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
