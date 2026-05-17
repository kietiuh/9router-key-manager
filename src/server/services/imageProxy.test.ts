import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { buildImageProxyUrl, getImageProxyConfig, isImageProxyPath, maybeRewriteImageModel, parseImageUsage, saveImageProxyConfig } from './imageProxy.js';

const config = { enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through' as const, modelOverride: '' };
const db = () => {
  const d = new Database(':memory:');
  migrate(d);
  return d;
};

describe('imageProxy', () => {
  it('matches only supported image paths', () => {
    expect(isImageProxyPath('/v1/images/generations')).toBe(true);
    expect(isImageProxyPath('/v1/images/edits')).toBe(true);
    expect(isImageProxyPath('/v1/chat/completions')).toBe(false);
  });

  it('builds upstream url while preserving query string', () => {
    expect(buildImageProxyUrl(config, '/v1/images/generations?x=1')).toBe('https://shopapikey.com/v1/images/generations?x=1');
  });

  it('rewrites json model only when configured', () => {
    const body = Buffer.from(JSON.stringify({ model: 'old', prompt: 'x' }));
    const next = maybeRewriteImageModel(body, 'application/json', 'cx/gpt-5.4-image');
    expect(JSON.parse(next!.toString('utf8')).model).toBe('cx/gpt-5.4-image');
    expect(maybeRewriteImageModel(body, 'application/json', '')).toBe(body);
    expect(maybeRewriteImageModel(body, 'text/plain', 'new')).toBe(body);
    expect(maybeRewriteImageModel(Buffer.from('not-json'), 'application/json', 'new')?.toString()).toBe('not-json');
    expect(maybeRewriteImageModel(Buffer.from('null'), 'application/json', 'new')?.toString()).toBe('null');
  });

  it('returns default config when settings are absent or invalid', () => {
    const d = db();
    expect(getImageProxyConfig(d)).toEqual({ enabled: false, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through', modelOverride: '' });
    d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('image_proxy_config', '{');
    expect(getImageProxyConfig(d).enabled).toBe(false);
    d.close();
  });

  it('normalizes and persists image proxy config', () => {
    const d = db();
    const saved = saveImageProxyConfig(d, { enabled: true, upstreamBaseUrl: 'https://shopmmo.id.vn/v1///', authMode: 'server-key', modelOverride: ' cx/gpt-image ' });

    expect(saved).toEqual({ enabled: true, upstreamBaseUrl: 'https://shopmmo.id.vn/v1', authMode: 'server-key', modelOverride: 'cx/gpt-image' });
    expect(getImageProxyConfig(d)).toEqual(saved);
    d.close();
  });

  it('falls back to allowed upstream and pass-through auth for invalid stored config', () => {
    const d = db();
    d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('image_proxy_config', JSON.stringify({ enabled: true, upstreamBaseUrl: 'https://evil.test/v1', authMode: 'other', modelOverride: 123 }));

    expect(getImageProxyConfig(d)).toEqual({ enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through', modelOverride: '123' });
    d.close();
  });

  it('parses image usage metadata and upstream errors', () => {
    const body = Buffer.from(JSON.stringify({ model: 'm', size: '1024x1024', prompt: 'x'.repeat(200), n: 25 }));
    expect(parseImageUsage(body, 4096, 502)).toEqual({
      kind: 'proxy',
      model: 'm',
      size: '1024x1024',
      promptPreview: 'x'.repeat(160),
      imageCount: 20,
      bytes: 4096,
      status: 'error',
      error: 'upstream status 502',
    });
  });

  it('uses safe image usage defaults for invalid request bodies', () => {
    expect(parseImageUsage(Buffer.from('{'), 12, 201)).toEqual({
      kind: 'proxy',
      model: 'unknown',
      imageCount: 1,
      bytes: 12,
      status: 'success',
      error: undefined,
    });
  });
});
