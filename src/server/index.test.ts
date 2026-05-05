import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './db/schema.js';
import { buildApp } from './index.js';

let tmpDir: string;
let oldNineRouterDir: string | undefined;
let oldHardDisable: string | undefined;
let oldFetch: typeof globalThis.fetch;

function writeRouterFiles(keys = [{ id: 'key-1', name: 'Primary', key: 'sk-test-12345678', isActive: true }], history: any[] = []) {
  fs.writeFileSync(path.join(tmpDir, 'db.json'), JSON.stringify({ apiKeys: keys }));
  fs.writeFileSync(path.join(tmpDir, 'usage.json'), JSON.stringify({ history }));
}

async function testApp() {
  const db = new Database(':memory:');
  migrate(db);
  const app = await buildApp({ db, adminPassword: 'secret', sessionSecret: 'test-secret'.repeat(4), secureCookie: false, logger: false, webRoot: path.join(tmpDir, 'missing-web') });
  return { app, db };
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret' } });
  return res.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

describe('server routes', () => {
  beforeEach(() => {
    oldNineRouterDir = process.env.NINE_ROUTER_DIR;
    oldHardDisable = process.env.HARD_DISABLE;
    oldFetch = globalThis.fetch;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-routes-'));
    process.env.NINE_ROUTER_DIR = tmpDir;
    process.env.HARD_DISABLE = 'false';
    writeRouterFiles();
  });

  afterEach(() => {
    if (oldNineRouterDir === undefined) delete process.env.NINE_ROUTER_DIR;
    else process.env.NINE_ROUTER_DIR = oldNineRouterDir;
    if (oldHardDisable === undefined) delete process.env.HARD_DISABLE;
    else process.env.HARD_DISABLE = oldHardDisable;
    globalThis.fetch = oldFetch;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets a signed admin session only for the correct password', async () => {
    const { app } = await testApp();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'secret' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(ok.cookies[0]).toMatchObject({ name: 'admin_session', httpOnly: true, sameSite: 'Lax' });
    expect(ok.cookies[0].value).toContain('.');
    await app.close();
  });

  it('rejects protected routes without a valid session and clears logout cookie', async () => {
    const { app } = await testApp();
    const denied = await app.inject({ method: 'GET', url: '/api/config/status' });
    expect(denied.statusCode).toBe(401);

    const cookie = await loginCookie(app);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies[0]).toMatchObject({ name: 'admin_session', value: '' });
    await app.close();
  });

  it('checks public keys without auth and trims submitted keys', async () => {
    const { app } = await testApp();
    const short = await app.inject({ method: 'POST', url: '/api/public/key-check', payload: { key: 'short' } });
    expect(short.statusCode).toBe(500);

    const missing = await app.inject({ method: 'POST', url: '/api/public/key-check', payload: { key: 'sk-missing-123456' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'key not found' });

    const ok = await app.inject({ method: 'POST', url: '/api/public/key-check', payload: { key: '  sk-test-12345678  ' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ keyId: 'key-1', name: 'Primary', status: 'unlimited' });
    await app.close();
  });

  it('reports config file presence for the configured 9router dir', async () => {
    const { app } = await testApp();
    const cookie = await loginCookie(app);
    const ok = await app.inject({ method: 'GET', url: '/api/config/status', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, nineRouterDir: tmpDir, dbJsonExists: true, usageJsonExists: true, hardDisable: false });

    fs.unlinkSync(path.join(tmpDir, 'usage.json'));
    const missing = await app.inject({ method: 'GET', url: '/api/config/status', headers: { cookie } });
    expect(missing.json()).toMatchObject({ ok: false, usageJsonExists: false });
    expect(missing.json().errors[0]).toContain('Missing 9router usage.json');
    await app.close();
  });

  it('updates policy, audits changes, and records multiplier events only when changed', async () => {
    const { app, db } = await testApp();
    const cookie = await loginCookie(app);
    await app.inject({ method: 'GET', url: '/api/keys/usage', headers: { cookie } });

    const invalid = await app.inject({ method: 'PATCH', url: '/api/keys/key-1/policy', headers: { cookie }, payload: { usageMultiplier: 101 } });
    expect(invalid.statusCode).toBe(500);

    const unchanged = await app.inject({ method: 'PATCH', url: '/api/keys/key-1/policy', headers: { cookie }, payload: { usageMultiplier: 1, tokenLimit: 100 } });
    expect(unchanged.statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) count FROM usage_multiplier_events').get()).toMatchObject({ count: 0 });

    const changed = await app.inject({ method: 'PATCH', url: '/api/keys/key-1/policy', headers: { cookie }, payload: { usageMultiplier: 2, actionOnLimit: 'disable' } });
    expect(changed.statusCode).toBe(200);
    expect(db.prepare('SELECT multiplier FROM usage_multiplier_events').all()).toEqual([{ multiplier: 2 }]);
    expect(db.prepare('SELECT action FROM audit_log ORDER BY id').all()).toEqual([{ action: 'policy.update' }, { action: 'policy.update' }]);
    await app.close();
  });

  it('enforces reset-window policy constraints', async () => {
    const { app, db } = await testApp();
    const cookie = await loginCookie(app);
    await app.inject({ method: 'GET', url: '/api/keys/usage', headers: { cookie } });

    const missing = await app.inject({ method: 'POST', url: '/api/keys/missing/reset-window', headers: { cookie } });
    expect(missing.statusCode).toBe(404);

    const daily = await app.inject({ method: 'POST', url: '/api/keys/key-1/reset-window', headers: { cookie } });
    expect(daily.statusCode).toBe(409);

    db.prepare("UPDATE key_policies SET reset_policy = 'manual' WHERE key_id = 'key-1'").run();
    const manual = await app.inject({ method: 'POST', url: '/api/keys/key-1/reset-window', headers: { cookie } });
    expect(manual.statusCode).toBe(200);
    expect(db.prepare('SELECT action FROM audit_log').all()).toEqual([{ action: 'window.reset' }]);
    await app.close();
  });

  it('serves health, auth status, image usage, model rewrite config, watcher, and audit routes', async () => {
    const { app, db } = await testApp();
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, service: '9router-key-manager' });

    expect((await app.inject({ method: 'GET', url: '/api/auth/status' })).json()).toEqual({ authenticated: false });
    const cookie = await loginCookie(app);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', headers: { cookie } })).json()).toEqual({ authenticated: true });

    const modelCfg = await app.inject({ method: 'PUT', url: '/api/model-rewrite/config', headers: { cookie }, payload: { enabled: true, rules: [{ fromModel: ' A ', toModel: ' B ', note: ' n ' }] } });
    expect(modelCfg.statusCode).toBe(200);
    expect(modelCfg.json()).toMatchObject({ enabled: true, rules: [{ enabled: true, fromModel: 'A', toModel: 'B', note: 'n' }] });
    expect((await app.inject({ method: 'GET', url: '/api/model-rewrite/config', headers: { cookie } })).json().rules).toHaveLength(1);

    const img = await app.inject({ method: 'POST', url: '/api/images/usage', headers: { cookie }, payload: { kind: 'gen', model: 'm', status: 'success', imageCount: 2, bytes: 10 } });
    expect(img.json()).toEqual({ ok: true });
    const imgSummary = await app.inject({ method: 'GET', url: '/api/images/usage', headers: { cookie } });
    expect(imgSummary.json()).toMatchObject({ totalImages: 2, success: 1, errors: 0, bytes: 10 });

    await app.inject({ method: 'GET', url: '/api/keys/usage', headers: { cookie } });
    db.prepare("UPDATE key_policies SET token_limit = 1, action_on_limit = 'alert', reset_policy = 'manual', window_start = '2026-05-01T00:00:00.000Z' WHERE key_id = 'key-1'").run();
    writeRouterFiles(undefined, [{ apiKey: 'sk-test-12345678', model: 'm', timestamp: '2026-05-01T00:00:00.000Z', tokens: { total_tokens: 2 } }]);
    const watcher = await app.inject({ method: 'POST', url: '/api/watcher/run', headers: { cookie } });
    expect(watcher.statusCode).toBe(200);
    expect(watcher.json().events).toHaveLength(1);
    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    expect(audit.json()[0]).toMatchObject({ key_id: 'key-1', action: 'alert' });
    await app.close();
  });

  it('proxies /v1 requests, rewrites matching JSON models, and forwards upstream response', async () => {
    const { app, db } = await testApp();
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('model_rewrite_enabled', 'true')").run();
    db.prepare("INSERT INTO model_rewrite_rules (enabled, from_model, to_model) VALUES (1, 'from-model', 'to-model')").run();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe('http://upstream.test/v1/chat/completions?x=1');
      expect(init.method).toBe('POST');
      expect(JSON.parse(Buffer.from(init.body as any).toString('utf8')).model).toBe('to-model');
      expect((init.headers as Headers).get('content-length')).toBe(String(Buffer.from(init.body as any).length));
      return new Response('proxied-body', { status: 201, headers: { 'x-upstream': 'ok', connection: 'close' } });
    });
    globalThis.fetch = fetchMock as any;
    const proxyApp = await buildApp({ db, adminPassword: 'secret', sessionSecret: 'test-secret'.repeat(4), secureCookie: false, logger: false, webRoot: path.join(tmpDir, 'missing-web'), nineRouterUpstream: 'http://upstream.test/' });

    const res = await proxyApp.inject({ method: 'POST', url: '/v1/chat/completions?x=1', headers: { 'content-type': 'application/json', host: 'local', connection: 'keep-alive' }, payload: Buffer.from(JSON.stringify({ model: 'from-model', stream: true })) });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-upstream']).toBe('ok');
    expect(res.body).toBe('proxied-body');
    expect(fetchMock).toHaveBeenCalledOnce();
    await proxyApp.close();
  });

  it('proxies GET and HEAD requests without a body', async () => {
    const { db } = await testApp();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as any;
    const proxyApp = await buildApp({ db, adminPassword: 'secret', sessionSecret: 'test-secret'.repeat(4), secureCookie: false, logger: false, webRoot: path.join(tmpDir, 'missing-web'), nineRouterUpstream: 'http://upstream.test' });
    expect((await proxyApp.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(204);
    expect((await proxyApp.inject({ method: 'HEAD', url: '/v1/models' })).statusCode).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await proxyApp.close();
  });
});
