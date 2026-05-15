import { describe, expect, it } from 'vitest';
import { buildImageProxyUrl, isImageProxyPath, maybeRewriteImageModel } from './imageProxy.js';

const config = { enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through' as const, modelOverride: '' };

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
  });
});
