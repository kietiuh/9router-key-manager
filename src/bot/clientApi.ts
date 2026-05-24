import type { KeyUsageSummary } from '../shared/types.js';

export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PublicApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'PublicApiError';
    this.statusCode = statusCode;
  }
}

export class KeyManagerPublicApi {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(args: { baseUrl: string; fetchFn?: FetchFn; timeoutMs?: number }) {
    this.baseUrl = args.baseUrl.replace(/\/$/, '');
    this.fetchFn = args.fetchFn ?? fetch;
    this.timeoutMs = args.timeoutMs ?? 15_000;
  }

  async checkKey(apiKey: string): Promise<KeyUsageSummary> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/public/key-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: apiKey }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) throw new PublicApiError(typeof body.error === 'string' ? body.error : `GoCinema API returned ${response.status}`, response.status);
      return body as KeyUsageSummary;
    } catch (error) {
      if (error instanceof PublicApiError) throw error;
      throw new PublicApiError('Không kết nối được GoCinema API', 0);
    } finally {
      clearTimeout(timeout);
    }
  }
}
