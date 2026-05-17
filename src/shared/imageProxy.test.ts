import { describe, expect, it } from 'vitest';
import { imageProxyNeedsServerKey, isAllowedImageProxyBaseUrl, normalizeImageProxyBaseUrl } from './imageProxy.js';

describe('shared image proxy config', () => {
  it('normalizes and validates supported upstream URLs', () => {
    expect(normalizeImageProxyBaseUrl(' https://shopapikey.com/v1/// ')).toBe('https://shopapikey.com/v1');
    expect(isAllowedImageProxyBaseUrl('https://shopapikey.com/v1/')).toBe(true);
    expect(isAllowedImageProxyBaseUrl('https://evil.test/v1')).toBe(false);
  });

  it('requires a server key only when enabled in server-key mode', () => {
    expect(imageProxyNeedsServerKey({ enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'server-key' })).toBe(true);
    expect(imageProxyNeedsServerKey({ enabled: true, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'pass-through' })).toBe(false);
    expect(imageProxyNeedsServerKey({ enabled: false, upstreamBaseUrl: 'https://shopapikey.com/v1', authMode: 'server-key' })).toBe(false);
  });
});
