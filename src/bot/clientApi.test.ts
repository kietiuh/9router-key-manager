import { describe, expect, it } from 'vitest';
import { KeyManagerPublicApi, PublicApiError } from './clientApi.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('KeyManagerPublicApi', () => {
  it('checks a key through the existing public key-check endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, { keyId: 'k1', name: 'Client A', keyMasked: 'sk-a...test', status: 'ok', total: 100, tokenLimit: 1000 });
    };
    const api = new KeyManagerPublicApi({ baseUrl: 'http://127.0.0.1:3000', fetchFn });

    await expect(api.checkKey('sk-secret')).resolves.toMatchObject({ keyId: 'k1', total: 100 });
    expect(calls[0].url).toBe('http://127.0.0.1:3000/api/public/key-check');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ key: 'sk-secret' }));
  });

  it('throws a typed public api error for invalid keys', async () => {
    const api = new KeyManagerPublicApi({
      baseUrl: 'http://127.0.0.1:3000/',
      fetchFn: async () => jsonResponse(404, { error: 'key not found' }),
    });

    await expect(api.checkKey('sk-missing')).rejects.toMatchObject({
      name: 'PublicApiError',
      statusCode: 404,
      message: 'key not found',
    });
  });

  it('wraps network errors with a user-safe message', async () => {
    const api = new KeyManagerPublicApi({
      baseUrl: 'http://127.0.0.1:3000',
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(api.checkKey('sk-secret')).rejects.toBeInstanceOf(PublicApiError);
    await expect(api.checkKey('sk-secret')).rejects.toMatchObject({
      statusCode: 0,
      message: 'Không kết nối được GoCinema API',
    });
  });
});
