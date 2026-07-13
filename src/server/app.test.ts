import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServerApp, type ServerAppOptions } from './app.js';
import { ingestUsageHistory } from './services/usageStore.js';
import type { UsageRecord } from '../shared/types.js';

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

  it('uses final fallback by default for known client keys', async () => {
    const calls: string[] = [];
    const key = { id: 'key-default-fallback', name: 'Default Fallback', key: 'sk-default-fallback', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        const model = JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model;
        calls.push(model);
        return new Response(JSON.stringify({ model }), { status: model === 'stable/fallback' ? 200 : 500, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PUT',
      url: '/api/final-fallback/config',
      headers: { cookie },
      payload: { enabled: true, model: 'stable/fallback', models: ['stable/fallback'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'v4/source', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['v4/source', 'stable/fallback']);
  });

  it('does not use final fallback when the client key policy disables it', async () => {
    const calls: string[] = [];
    const key = { id: 'key-no-fallback', name: 'No Fallback', key: 'sk-no-fallback', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        const model = JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model;
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: `${model} failed` } }), { status: 500, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PUT',
      url: '/api/final-fallback/config',
      headers: { cookie },
      payload: { enabled: true, model: 'stable/fallback', models: ['stable/fallback'] },
    });
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowFinalFallback: false },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'v4/source', messages: [] },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { message: 'v4/source failed' } });
    expect(calls).toEqual(['v4/source']);
  });

  it('returns 404 for removed image feature endpoints', async () => {
    const { instance: server } = await app();
    const cookie = await adminCookie(server);

    const [adminImageUsage, adminImageProxy, publicImageApi] = await Promise.all([
      server.inject({ method: 'GET', url: '/api/images/usage', headers: { cookie } }),
      server.inject({ method: 'GET', url: '/api/image-proxy/config', headers: { cookie } }),
      server.inject({ method: 'POST', url: '/api/public/images/jobs', payload: { key: 'sk-test', prompt: 'cat' } }),
    ]);

    expect(adminImageUsage.statusCode).toBe(404);
    expect(adminImageProxy.statusCode).toBe(404);
    expect(publicImageApi.statusCode).toBe(404);
  });

  it('returns 404 for removed image pages', async () => {
    const { instance: server } = await app();

    const [imagesPage, imageAlias] = await Promise.all([
      server.inject({ method: 'GET', url: '/images' }),
      server.inject({ method: 'GET', url: '/image' }),
    ]);

    expect(imagesPage.statusCode).toBe(404);
    expect(imageAlias.statusCode).toBe(404);
  });

  it('blocks a request whose model is not in the key whitelist', async () => {
    const calls: string[] = [];
    const key = { id: 'key-restricted', name: 'Restricted', key: 'sk-restricted', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-haiku-5', messages: [] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
    expect(res.json().error.allowed_models).toEqual(['claude-opus-4.8']);
    expect(calls).toEqual([]);
  });

  it('allows a request whose model is in the key whitelist', async () => {
    const calls: string[] = [];
    const key = { id: 'key-allowed', name: 'Allowed', key: 'sk-allowed', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4.8', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['claude-opus-4.8']);
  });

  it('does not restrict models when the whitelist is cleared with null', async () => {
    const calls: string[] = [];
    const key = { id: 'key-cleared', name: 'Cleared', key: 'sk-cleared', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({ method: 'PATCH', url: `/api/keys/${key.id}/policy`, headers: { cookie }, payload: { allowedModels: ['claude-opus-4.8'] } });
    await server.inject({ method: 'PATCH', url: `/api/keys/${key.id}/policy`, headers: { cookie }, payload: { allowedModels: null } });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-haiku-5', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['claude-haiku-5']);
  });

  it('does not leak allowedModels through the public key-check endpoint', async () => {
    const key = { id: 'key-public', name: 'Public', key: 'sk-public', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8', 'gpt-5.5'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/public/key-check',
      payload: { key: key.key },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).not.toHaveProperty('allowedModels');
  });

  it('allows a whitelisted incoming model even when rewrite maps it to a non-whitelisted target', async () => {
    const calls: Array<{ model: string; url: string }> = [];
    const key = { id: 'key-rewrite-via-whitelist', name: 'Rewrite via whitelist', key: 'sk-rewrite-via-whitelist', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (input, init) => {
        const upstreamUrl = String(input);
        const body = init?.body as unknown;
        const parsed = Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : (typeof body === 'string' ? JSON.parse(body) : body);
        calls.push({ model: parsed?.model, url: upstreamUrl });
        return new Response(JSON.stringify({ model: parsed?.model }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8'] },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/model-rewrite/config',
      headers: { cookie },
      payload: {
        enabled: true,
        rules: [
          { enabled: true, fromModel: 'claude-opus-4.8', toModel: 'super/claude-opus-4.8', stickyCount: 1 },
        ],
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4.8', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('super/claude-opus-4.8');
    expect(calls[0].url).toMatch(/\/v1\/chat\/completions$/);
  });

  describe('/api/keys/:keyId/usage-events', () => {
    function seedEvents(dbPath: string, apiKey: string, count = 3, start = '2026-07-10T00:00:00.000Z', extra: Record<string, unknown> = {}) {
      const d = new Database(dbPath);
      try {
        const rows = Array.from({ length: count }, (_, i) => ({
          apiKey,
          model: extra.model ?? 'gpt-5.5',
          provider: extra.provider ?? 'prov',
          connectionId: `conn-${i}`,
          timestamp: new Date(Date.parse(start) + i * 60_000).toISOString(),
          cost: 0.001 * (i + 1),
          tokens: {
            prompt_tokens: 10 + i,
            completion_tokens: 5 + i,
            total_tokens: 15 + 2 * i,
            cache_read_input_tokens: extra.cacheRead ?? 0,
            cache_creation_input_tokens: extra.cacheWrite ?? 0,
          },
        }));
        ingestUsageHistory(d, rows as unknown as UsageRecord[]);
      } finally { d.close(); }
    }

    it('requires authentication', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server } = await app({ readApiKeys: () => [key] });

      const res = await server.inject({ method: 'GET', url: `/api/keys/${key.id}/usage-events` });
      expect(res.statusCode).toBe(401);
    });

    it('returns rows in DESC order with cache columns', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server, dbPath } = await app({ readApiKeys: () => [key] });
      seedEvents(dbPath, key.key, 3, '2026-07-10T00:00:00.000Z', { cacheRead: 4, cacheWrite: 2 });
      const cookie = await adminCookie(server);

      const res = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { rows: Array<{ timestamp: string; cacheReadTokens: number | null; cacheCreationTokens: number | null }>; hasMore: boolean; nextCursor: string | null };
      expect(body.rows).toHaveLength(3);
      expect(body.rows[0].timestamp > body.rows[1].timestamp).toBe(true);
      expect(body.rows[0].cacheReadTokens).toBe(4);
      expect(body.rows[0].cacheCreationTokens).toBe(2);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
    });

    it('paginates and accepts a cursor', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server, dbPath } = await app({ readApiKeys: () => [key] });
      seedEvents(dbPath, key.key, 60, '2026-07-10T00:00:00.000Z');
      const cookie = await adminCookie(server);

      const first = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&pageSize=50`,
        headers: { cookie },
      });
      const firstBody = first.json() as { rows: Array<{ id: number }>; hasMore: boolean; nextCursor: string | null };
      expect(firstBody.rows).toHaveLength(50);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).not.toBeNull();

      const second = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&pageSize=50&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        headers: { cookie },
      });
      const secondBody = second.json() as { rows: Array<{ id: number }>; hasMore: boolean };
      const ids = [...firstBody.rows, ...secondBody.rows].map(r => r.id);
      expect(new Set(ids).size).toBe(60);
      expect(secondBody.hasMore).toBe(false);
    });

    it('rejects invalid pageSize with 400', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server } = await app({ readApiKeys: () => [key] });
      const cookie = await adminCookie(server);

      const res = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events?pageSize=999`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects invalid cursor with 400', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server } = await app({ readApiKeys: () => [key] });
      const cookie = await adminCookie(server);

      const res = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events?cursor=not-a-cursor`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s on unknown keyId', async () => {
      const { instance: server } = await app({ readApiKeys: () => [] });
      const cookie = await adminCookie(server);

      const res = await server.inject({
        method: 'GET',
        url: '/api/keys/no-such-key/usage-events',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns distinct models', async () => {
      const key = { id: 'log-key', name: 'Log', key: 'sk-log', isActive: true };
      const { instance: server, dbPath } = await app({ readApiKeys: () => [key] });
      const d = new Database(dbPath);
      try {
        ingestUsageHistory(d, [
          { apiKey: key.key, model: 'alpha', timestamp: '2026-07-10T00:00:00.000Z', tokens: { total_tokens: 1 } },
          { apiKey: key.key, model: 'beta', timestamp: '2026-07-11T00:00:00.000Z', tokens: { total_tokens: 1 } },
          { apiKey: key.key, model: 'alpha', timestamp: '2026-07-12T00:00:00.000Z', tokens: { total_tokens: 1 } },
        ]);
      } finally { d.close(); }
      const cookie = await adminCookie(server);

      const res = await server.inject({
        method: 'GET',
        url: `/api/keys/${key.id}/usage-events/models?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as string[]).sort()).toEqual(['alpha', 'beta']);
    });
  });

});
