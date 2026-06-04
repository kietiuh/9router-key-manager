import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerApp, type ServerAppOptions } from './app.js';

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

async function app(options: Partial<ServerAppOptions> = {}) {
  const dbPath = options.dbPath ?? tempDbPath();
  const instance = await createServerApp({
    adminPassword: 'test-password',
    disableBackgroundJobs: true,
    dbPath,
    ...options,
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

  it('proxies unknown bearer tokens to the upstream path', async () => {
    let upstreamUrl = '';
    const { instance: server } = await app({
      fetchImpl: async (input) => {
        upstreamUrl = String(input);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-unknown', 'content-type': 'application/json' },
      payload: { model: 'v4/test', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(upstreamUrl).toBe('http://127.0.0.1:20128/v1/chat/completions');
  });

  it('blocks expired known keys before proxying upstream', async () => {
    let upstreamCalls = 0;
    const key = { id: 'key-expired', name: 'Expired', key: 'sk-expired', isActive: true };
    const { instance: server, dbPath } = await app({
      readApiKeys: () => [key],
      fetchImpl: async () => {
        upstreamCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const db = new Database(dbPath);
    db.prepare('INSERT INTO key_policies (key_id, name, window_start, expires_at, reset_policy) VALUES (?, ?, ?, ?, ?)')
      .run(key.id, key.name, '2026-06-04T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'daily');
    db.close();

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'v4/test', messages: [] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { message: 'This API key expired at 2026-01-01T00:00:00.000Z.', type: 'permission_denied', code: 'key_expired', expires_at: '2026-01-01T00:00:00.000Z' } });
    expect(upstreamCalls).toBe(0);
  });

  it('rejects requests when the client RPM limiter is exceeded', async () => {
    const key = { id: 'key-rpm', name: 'RPM', key: 'sk-rpm', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PUT',
      url: '/api/client-rate-limit/config',
      headers: { cookie },
      payload: { enabled: true, rpm: 1, concurrency: 5 },
    });

    const first = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'v4/test', messages: [] },
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'v4/test', messages: [] },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.json().error.code).toBe('client_rpm_exceeded');
  });

  it('uses the direct image proxy path when image proxy is enabled', async () => {
    let upstreamUrl = '';
    const key = { id: 'key-image', name: 'Image', key: 'sk-image', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (input) => {
        upstreamUrl = String(input);
        return new Response(Buffer.from('png'), { status: 201, headers: { 'content-type': 'image/png' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PUT',
      url: '/api/image-proxy/config',
      headers: { cookie },
      payload: { enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through', modelOverride: 'cx/test-image' },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'ignored', prompt: 'cat', n: 1, size: '1024x1024' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['x-image-proxy']).toBe('direct');
    expect(res.body).toBe('png');
    expect(upstreamUrl).toBe('https://shopapikey.com/v1/images/generations');
  });
});
