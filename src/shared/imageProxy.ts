export const IMAGE_PROXY_ALLOWED_BASE_URLS = [
  'https://shopapikey.com/v1',
  'https://shopmmo.id.vn/v1',
] as const;

export type ImageProxyAuthMode = 'pass-through' | 'server-key';

export type ImageProxyConfig = {
  enabled: boolean;
  upstreamBaseUrl: string;
  authMode: ImageProxyAuthMode;
  modelOverride?: string;
};

export const DEFAULT_IMAGE_PROXY_CONFIG: ImageProxyConfig = {
  enabled: false,
  upstreamBaseUrl: 'https://shopapikey.com/v1',
  authMode: 'pass-through',
  modelOverride: '',
};

export function normalizeImageProxyBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isAllowedImageProxyBaseUrl(value: string): boolean {
  const normalized = normalizeImageProxyBaseUrl(value);
  return (IMAGE_PROXY_ALLOWED_BASE_URLS as readonly string[]).includes(normalized);
}

export function imageProxyNeedsServerKey(config: ImageProxyConfig): boolean {
  return config.enabled && config.authMode === 'server-key';
}
