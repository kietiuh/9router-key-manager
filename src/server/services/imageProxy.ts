import Database from 'better-sqlite3';
import { DEFAULT_IMAGE_PROXY_CONFIG, isAllowedImageProxyBaseUrl, normalizeImageProxyBaseUrl, type ImageProxyConfig } from '../../shared/imageProxy.js';

const SETTING_KEY = 'image_proxy_config';

export function isImageProxyPath(path: string): boolean {
  return path === '/v1/images/generations' || path === '/v1/images/edits';
}

function coerceConfig(value: unknown): ImageProxyConfig {
  const input = typeof value === 'object' && value ? value as Partial<ImageProxyConfig> : {};
  const upstreamBaseUrl = normalizeImageProxyBaseUrl(String(input.upstreamBaseUrl ?? DEFAULT_IMAGE_PROXY_CONFIG.upstreamBaseUrl));
  const authMode = input.authMode === 'server-key' ? 'server-key' : 'pass-through';
  return {
    enabled: Boolean(input.enabled),
    upstreamBaseUrl: isAllowedImageProxyBaseUrl(upstreamBaseUrl) ? upstreamBaseUrl : DEFAULT_IMAGE_PROXY_CONFIG.upstreamBaseUrl,
    authMode,
    modelOverride: String(input.modelOverride ?? '').trim(),
  };
}

export function getImageProxyConfig(db: Database.Database): ImageProxyConfig {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_IMAGE_PROXY_CONFIG };
  try {
    return coerceConfig(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_IMAGE_PROXY_CONFIG };
  }
}

export function saveImageProxyConfig(db: Database.Database, config: ImageProxyConfig): ImageProxyConfig {
  const next = coerceConfig(config);
  if (!isAllowedImageProxyBaseUrl(next.upstreamBaseUrl)) throw new Error('image proxy upstream is not allowed');
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(SETTING_KEY, JSON.stringify(next));
  return next;
}

export function buildImageProxyUrl(config: ImageProxyConfig, rawUrl: string): string {
  const input = new URL(rawUrl, 'http://local');
  const upstream = new URL(config.upstreamBaseUrl + input.pathname.replace(/^\/v1/, ''));
  upstream.search = input.search;
  return upstream.toString();
}

export function maybeRewriteImageModel(body: Buffer | undefined, contentType: string | undefined, modelOverride: string | undefined): Buffer | undefined {
  const model = modelOverride?.trim();
  if (!body || !model || !contentType?.toLowerCase().includes('application/json')) return body;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return body;
    parsed.model = model;
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

export function parseImageUsage(body: Buffer | undefined, responseBytes: number, status: number): { kind: string; model: string; size?: string; promptPreview?: string; imageCount: number; bytes: number; status: string; error?: string } {
  let model = 'unknown';
  let size: string | undefined;
  let promptPreview: string | undefined;
  let imageCount = 1;
  try {
    if (body) {
      const parsed = JSON.parse(body.toString('utf8'));
      if (typeof parsed.model === 'string') model = parsed.model;
      if (typeof parsed.size === 'string') size = parsed.size;
      if (typeof parsed.prompt === 'string') promptPreview = parsed.prompt.slice(0, 160);
      if (typeof parsed.n === 'number' && parsed.n > 0) imageCount = Math.min(Math.floor(parsed.n), 20);
    }
  } catch { /* ignore */ }
  return { kind: 'proxy', model, size, promptPreview, imageCount, bytes: responseBytes, status: status >= 200 && status < 300 ? 'success' : 'error', error: status >= 400 ? `upstream status ${status}` : undefined };
}
