import type { KeyUsageSummary } from '../shared/types.js';

export type ReplyKeyboardMarkup = {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
  is_persistent: boolean;
};

export function menuMarkup(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: '📊 Quota' }, { text: '🔑 Key' }],
      [{ text: '🔔 Thông báo' }, { text: '📜 Lịch sử' }],
      [{ text: '⚙️ Cài đặt' }, { text: '❓ Trợ giúp' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return new Intl.NumberFormat('vi-VN').format(Math.round(value));
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${Math.round(value)}%`;
}

function formatLocalDateTime(iso: string | null | undefined, timezoneOffsetHours: number): string {
  if (!iso) return '-';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '-';
  const shifted = new Date(time + timezoneOffsetHours * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 16).replace('T', ' ')} UTC${timezoneOffsetHours >= 0 ? '+' : ''}${timezoneOffsetHours}`;
}

export function noKeyText(): string {
  return [
    'Bạn chưa lưu GoCinema API key.',
    'Dùng /key_change rồi gửi key để bot có thể kiểm tra quota và gửi thông báo.',
  ].join('\n');
}

export function formatHelpText(): string {
  return [
    'GoCinema Assistant',
    '',
    '/quota hoặc /check - kiểm tra quota',
    '/refresh - làm mới quota',
    '/key - xem key đang lưu',
    '/key_change - thay key',
    '/alerts_on - bật thông báo quota',
    '/alerts_off - tắt thông báo quota',
    '/threshold_custom - nhập ngưỡng cảnh báo tùy chọn',
    '/history - lịch sử kiểm tra',
    '/settings - cài đặt',
    '/cancel - hủy thao tác đang nhập',
    '',
    'Bot được thiết kế để mở rộng thêm các module client khác sau này.',
  ].join('\n');
}

export function formatKeyText(args: { keyMasked: string | null | undefined }): string {
  if (!args.keyMasked) return noKeyText();
  return [`🔑 Key đang lưu`, args.keyMasked, '', 'Dùng /key_change để thay key.'].join('\n');
}

export function formatSettingsText(args: { alertsEnabled: boolean; alertThresholdPercent: number }): string {
  const alertLine = args.alertsEnabled
    ? `🔔 Cảnh báo: đang bật, ngưỡng ${args.alertThresholdPercent}%`
    : `🔕 Cảnh báo: đang tắt, ngưỡng ${args.alertThresholdPercent}%`;
  return [
    '⚙️ Cài đặt',
    alertLine,
    '',
    '/alerts_on - bật thông báo',
    '/alerts_off - tắt thông báo',
    '/threshold_20, /threshold_10, /threshold_5 - đổi ngưỡng nhanh',
    '/threshold_custom - nhập ngưỡng 1-100',
  ].join('\n');
}

export function formatHistoryText(rows: Array<{
  success: boolean;
  maskedKey: string | null;
  status: string | null;
  total: number | null;
  tokenLimit: number | null;
  percentOfLimit: number | null;
  error: string | null;
  checkedAt: string;
}>, timezoneOffsetHours: number): string {
  if (!rows.length) return '📜 Lịch sử gần đây\nChưa có lần kiểm tra nào.';
  const lines = rows.map((row, index) => {
    const head = `${index + 1}. ${formatLocalDateTime(row.checkedAt, timezoneOffsetHours)} - ${row.success ? 'OK' : 'Lỗi'}`;
    if (!row.success) return `${head}\n   ${row.maskedKey ?? '-'}: ${row.error ?? 'unknown error'}`;
    const quota = row.tokenLimit
      ? `${formatNumber(row.total)} / ${formatNumber(row.tokenLimit)} tokens (${formatPercent(row.percentOfLimit)})`
      : `${formatNumber(row.total)} tokens`;
    return `${head}\n   ${row.maskedKey ?? '-'}: ${row.status ?? '-'} - ${quota}`;
  });
  return ['📜 Lịch sử gần đây', ...lines].join('\n');
}

export function formatQuotaMessage(args: {
  summary: KeyUsageSummary;
  alertsEnabled: boolean;
  alertThresholdPercent: number;
  timezoneOffsetHours: number;
}): string {
  const { summary } = args;
  const limit = summary.tokenLimit ?? null;
  const usageLine = limit
    ? `${formatNumber(summary.total)} / ${formatNumber(limit)} tokens (${formatPercent(summary.percentOfLimit)})`
    : `${formatNumber(summary.total)} tokens (không giới hạn)`;
  const resetAt = summary.windowEnd ?? null;
  const imageLine = summary.imageDailyLimit
    ? `Ảnh hôm nay: ${formatNumber(summary.imageDailyUsed)} / ${formatNumber(summary.imageDailyLimit)}`
    : `Ảnh hôm nay: ${formatNumber(summary.imageDailyUsed)}`;
  const alerts = args.alertsEnabled
    ? `Cảnh báo: bật, ngưỡng ${args.alertThresholdPercent}%`
    : `Cảnh báo: đang tắt`;

  return [
    '📊 Quota GoCinema',
    `${summary.name} (${summary.keyMasked})`,
    '',
    `Trạng thái: ${summary.status}`,
    `Lý do: ${summary.statusReason}`,
    `Token: ${usageLine}`,
    `Requests: ${formatNumber(summary.req)}`,
    imageLine,
    `Reset: ${formatLocalDateTime(resetAt, args.timezoneOffsetHours)}`,
    `Dùng gần nhất: ${formatLocalDateTime(summary.lastUsageAt, args.timezoneOffsetHours)}`,
    alerts,
  ].join('\n');
}
