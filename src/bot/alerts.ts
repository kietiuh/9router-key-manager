import type { KeyUsageSummary } from '../shared/types.js';
import { alertCategory, keyFingerprint } from '../shared/quotaAlerts.js';
import type { TelegramSender } from './bot.js';
import type { BotDatabase } from './database.js';
import { formatLocalDateTime, formatStatusLabel, quotaMarkup } from './formatting.js';

export { alertCategory, keyFingerprint };

export class AlertEngine {
  constructor(
    private readonly deps: {
      db: BotDatabase;
      telegram: TelegramSender;
      timezoneOffsetHours: number;
      batchLimit: number;
    },
  ) {}

  async runOnce(): Promise<void> {
    const jobs = this.deps.db.pendingAlertJobs(this.deps.batchLimit);
    for (const job of jobs) {
      try {
        if (this.deps.db.hasSentAlert(job.telegramUserId, job.keyFingerprint, job.resetAt, job.thresholdPercent, job.category)) {
          this.deps.db.markAlertJobSent(job.id);
          continue;
        }
        await this.deps.telegram.sendMessage(job.chatId, formatAlertMessage(job.summary, job.thresholdPercent, this.deps.timezoneOffsetHours), { reply_markup: quotaMarkup() });
        this.deps.db.recordAlertSent({
          telegramUserId: job.telegramUserId,
          maskedKey: job.maskedKey,
          keyFingerprint: job.keyFingerprint,
          resetAt: job.resetAt,
          thresholdPercent: job.thresholdPercent,
          category: job.category,
        });
        this.deps.db.markAlertJobSent(job.id);
      } catch (error) {
        this.deps.db.markAlertJobFailed(job.id, error instanceof Error ? error.message : 'unknown error');
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
