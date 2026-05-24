import crypto from 'node:crypto';
import type { KeyUsageSummary } from './types.js';

export type QuotaAlertCategory = 'token_low' | 'token_empty' | 'key_inactive' | 'key_expired';

export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
}

export function alertCategory(summary: KeyUsageSummary, thresholdPercent: number): QuotaAlertCategory | null {
  if (!summary.isActive || summary.status === 'inactive') return 'key_inactive';
  if (summary.status === 'expired') return 'key_expired';
  if (!summary.tokenLimit || summary.percentOfLimit == null) return null;
  const remainingPercent = Math.max(0, 100 - summary.percentOfLimit);
  if (remainingPercent <= 0 || summary.percentOfLimit >= 100) return 'token_empty';
  if (remainingPercent <= thresholdPercent) return 'token_low';
  return null;
}
