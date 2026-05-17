import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, messageFromErrorText } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api error parsing', () => {
  it('extracts flat API errors', () => {
    expect(messageFromErrorText('{"error":"image proxy disabled"}')).toBe('image proxy disabled');
  });

  it('extracts nested OpenAI-style API errors', () => {
    expect(messageFromErrorText('{"error":{"message":"Image upstream proxy error","type":"image_proxy_error"}}')).toBe('Image upstream proxy error');
  });

  it('extracts top-level message fields', () => {
    expect(messageFromErrorText('{"message":"missing auth"}')).toBe('missing auth');
  });

  it('keeps plain text errors readable', () => {
    expect(messageFromErrorText('upstream timeout')).toBe('upstream timeout');
    expect(messageFromErrorText('')).toBe('Request failed');
  });
});

describe('api', () => {
  it('sends credentials and parses json responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api<{ ok: boolean }>('/api/test')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({ credentials: 'include' }));
  });

  it('sets JSON content type when a body is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/test', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves explicit content type headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/test', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('text/plain');
  });

  it('returns undefined for empty 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(api('/api/no-content')).resolves.toBeUndefined();
  });

  it('throws readable errors from failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"nope"}}', { status: 500 })));

    await expect(api('/api/fail')).rejects.toThrow('nope');
  });
});
