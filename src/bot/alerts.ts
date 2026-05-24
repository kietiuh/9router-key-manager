import crypto from 'node:crypto';
import type { KeyUsageSummary } from '../shared/types.js';
import type { KeyChecker, TelegramSender } from './bot.js';
import type { AlertCategory, BotDatabase } from './database.js';
import { formatLocalDateTime, formatStatusLabel, quotaMarkup } from './formatting.js';

export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
}

export function alertCategory(summary: KeyUsageSummary, thresholdPercent: number): AlertCategory | null {
  if (!summary.isActive || summary.status === 'inactive') return 'key_inactive';
  if (summary.status === 'expired') return 'key_expired';
  if (!summary.tokenLimit || summary.percentOfLimit == null) return null;
  const remainingPercent = Math.max(0, 100 - summary.percentOfLimit);
  if (remainingPercent <= 0 || summary.percentOfLimit >= 100) return 'token_empty';
  if (remainingPercent <= thresholdPercent) return 'token_low';
  return null;
}

export class AlertEngine {
  constructor(
    private readonly deps: {
      db: BotDatabase;
      telegram: TelegramSender;
      api: KeyChecker;
      timezoneOffsetHours: number;
      batchLimit: number;
    },
  ) {}

  async runOnce(): Promise<void> {
    const users = this.deps.db.usersWithAlertsEnabled(this.deps.batchLimit);
    for (const user of users) {
      if (!user.apiKey) continue;
      try {
        const summary = await this.deps.api.checkKey(user.apiKey);
        this.deps.db.logQuotaCheck({
          telegramUserId: user.telegramUserId,
          source: 'alert',
          success: true,
          maskedKey: summary.keyMasked,
          status: summary.status,
          total: summary.total,
          tokenLimit: summary.tokenLimit,
          percentOfLimit: summary.percentOfLimit,
          resetAt: summary.windowEnd ?? null,
        });
        const category = alertCategory(summary, user.alertThresholdPercent);
        if (!category) continue;
        const fingerprint = keyFingerprint(user.apiKey);
        const resetAt = summary.windowEnd ?? null;
        if (this.deps.db.hasSentAlert(user.telegramUserId, fingerprint, resetAt, user.alertThresholdPercent, category)) continue;
        await this.deps.telegram.sendMessage(user.chatId, formatAlertMessage(summary, user.alertThresholdPercent, this.deps.timezoneOffsetHours), { reply_markup: quotaMarkup() });
        this.deps.db.recordAlertSent({
          telegramUserId: user.telegramUserId,
          maskedKey: summary.keyMasked,
          keyFingerprint: fingerprint,
          resetAt,
          thresholdPercent: user.alertThresholdPercent,
          category,
        });
      } catch (error) {
        this.deps.db.logQuotaCheck({
          telegramUserId: user.telegramUserId,
          source: 'alert',
          success: false,
          maskedKey: user.keyMasked,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
  }
}

function formatAlertMessage(summary: KeyUsageSummary, thresholdPercent: number, timezoneOffsetHours: number): string {
  const remainingPercent = summary.percentOfLimit == null ? null : Math.max(0, Math.round(100 - summary.percentOfLimit));
  const reset = summary.windowEnd ? formatLocalDateTime(summary.windowEnd, timezoneOffsetHours) : '-';
  const remaining = remainingPercent == null ? '-' : `${remainingPercent}%`;
  return [
    '🔔 Cảnh báo quota',
    `${summary.name} (${summary.keyMasked})`,
    '',
    `Còn lại: ${remaining}`,
    `Ngưỡng cảnh báo: ${thresholdPercent}%`,
    `Tình trạng: ${formatStatusLabel(summary.status)}`,
    `Reset lúc: ${reset}`,
    '',
    'Bấm Làm mới quota để xem chi tiết hoặc vào Cài đặt để tắt cảnh báo.',
  ].join('\n');
}
