import type { KeyStatus, KeyUsageSummary } from '../shared/types.js';
import { BOT_ACTIONS } from './actions.js';

export type ReplyKeyboardMarkup = {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard: boolean;
  is_persistent: boolean;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
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

export function homeMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '📊 Quota', callback_data: BOT_ACTIONS.QUOTA },
        { text: '🔑 Key', callback_data: BOT_ACTIONS.KEY },
      ],
      [
        { text: '📜 Lịch sử', callback_data: BOT_ACTIONS.HISTORY },
        { text: '⚙️ Cài đặt', callback_data: BOT_ACTIONS.SETTINGS },
      ],
      [{ text: '❓ Trợ giúp', callback_data: BOT_ACTIONS.HELP }],
    ],
  };
}

export function quotaMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Làm mới quota', callback_data: BOT_ACTIONS.QUOTA }],
      [
        { text: '🔑 Key', callback_data: BOT_ACTIONS.KEY },
        { text: '📜 Lịch sử', callback_data: BOT_ACTIONS.HISTORY },
      ],
      [
        { text: '⚙️ Cài đặt', callback_data: BOT_ACTIONS.SETTINGS },
        { text: '❓ Trợ giúp', callback_data: BOT_ACTIONS.HELP },
      ],
    ],
  };
}

export function noKeyMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔑 Lưu key', callback_data: BOT_ACTIONS.KEY_CHANGE }],
      [{ text: '❓ Trợ giúp', callback_data: BOT_ACTIONS.HELP }],
    ],
  };
}

export function cancelMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: 'Hủy thao tác', callback_data: BOT_ACTIONS.CANCEL }]],
  };
}

export function keyMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔁 Thay key', callback_data: BOT_ACTIONS.KEY_CHANGE }],
      [
        { text: '📊 Quota', callback_data: BOT_ACTIONS.QUOTA },
        { text: '⚙️ Cài đặt', callback_data: BOT_ACTIONS.SETTINGS },
      ],
    ],
  };
}

export function historyMarkup(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🔄 Làm mới lịch sử', callback_data: BOT_ACTIONS.HISTORY }],
      [
        { text: '📊 Quota', callback_data: BOT_ACTIONS.QUOTA },
        { text: '⚙️ Cài đặt', callback_data: BOT_ACTIONS.SETTINGS },
      ],
    ],
  };
}

export function settingsMarkup(args: { alertsEnabled: boolean }): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{
        text: args.alertsEnabled ? '🔕 Tắt cảnh báo' : '🔔 Bật cảnh báo',
        callback_data: args.alertsEnabled ? BOT_ACTIONS.ALERTS_OFF : BOT_ACTIONS.ALERTS_ON,
      }],
      [
        { text: '20%', callback_data: BOT_ACTIONS.THRESHOLD_20 },
        { text: '10%', callback_data: BOT_ACTIONS.THRESHOLD_10 },
        { text: '5%', callback_data: BOT_ACTIONS.THRESHOLD_5 },
      ],
      [{ text: '✏️ Nhập ngưỡng khác', callback_data: BOT_ACTIONS.THRESHOLD_CUSTOM }],
      [
        { text: '📊 Quota', callback_data: BOT_ACTIONS.QUOTA },
        { text: '🔑 Key', callback_data: BOT_ACTIONS.KEY },
      ],
    ],
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

export function formatLocalDateTime(iso: string | null | undefined, timezoneOffsetHours: number): string {
  if (!iso) return '-';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '-';
  const shifted = new Date(time + timezoneOffsetHours * 60 * 60 * 1000);
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const dd = pad2(shifted.getUTCDate());
  const month = pad2(shifted.getUTCMonth() + 1);
  return `${hh}:${mm} ${dd}/${month}/${shifted.getUTCFullYear()}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

const STATUS_LABELS: Record<KeyStatus, string> = {
  ok: '✅ Đang hoạt động',
  warning: '⚠️ Sắp hết quota',
  danger: '⛔ Đã hết quota',
  inactive: '🔒 Key đang tắt',
  expired: '⌛ Key đã hết hạn',
  unlimited: '♾ Chưa đặt giới hạn quota',
};

const STATUS_TEXT: Record<KeyStatus, string> = {
  ok: 'Đang hoạt động',
  warning: 'Sắp hết quota',
  danger: 'Đã hết quota',
  inactive: 'Key đang tắt',
  expired: 'Key đã hết hạn',
  unlimited: 'Chưa đặt giới hạn quota',
};

export function formatStatusLabel(status: KeyStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function formatStatusText(status: string | null): string {
  return status && status in STATUS_TEXT ? STATUS_TEXT[status as KeyStatus] : (status ?? '-');
}

function remainingPercent(summary: KeyUsageSummary): number | null {
  return summary.percentOfLimit == null ? null : Math.max(0, Math.round(100 - summary.percentOfLimit));
}

function remainingTokens(summary: KeyUsageSummary): number | null {
  if (!summary.tokenLimit) return null;
  return Math.max(0, summary.tokenLimit - summary.total);
}

function statusGuidance(summary: KeyUsageSummary): string | null {
  const remaining = remainingPercent(summary);
  if (summary.status === 'warning') return remaining == null ? 'Nên theo dõi quota hoặc bật cảnh báo.' : `Còn ${remaining}% quota. Nên bật cảnh báo để nhận thông báo sớm.`;
  if (summary.status === 'danger') return 'Quota đã chạm giới hạn. Key có thể bị khóa đến lần reset tiếp theo.';
  if (summary.status === 'inactive') return 'Key hiện không hoạt động. Hãy liên hệ admin nếu cần mở lại.';
  if (summary.status === 'expired') return 'Key đã hết hạn. Hãy liên hệ admin để gia hạn.';
  if (summary.status === 'unlimited') return 'Key chưa có giới hạn quota. Hãy cân nhắc đặt giới hạn để kiểm soát chi phí.';
  return null;
}

export function noKeyText(): string {
  return [
    'Bạn chưa lưu GoCinema API key.',
    'Bấm Lưu key bên dưới rồi gửi key để bot kiểm tra quota và gửi cảnh báo.',
  ].join('\n');
}

export function formatHomeText(): string {
  return [
    'GoCinema Assistant',
    'Chọn thao tác bên dưới. Các nút sẽ cập nhật ngay trong tin nhắn này khi có thể.',
  ].join('\n');
}

export function formatHelpText(): string {
  return [
    '❓ Trợ giúp',
    'Dùng các nút bên dưới để thao tác nhanh.',
    '',
    '📊 Quota - xem lượng token còn lại',
    '🔑 Key - xem hoặc thay API key',
    '🔔 Thông báo - bật/tắt cảnh báo quota',
    '📜 Lịch sử - 5 lần kiểm tra gần đây',
    '',
    'Khi bot đang chờ bạn nhập key hoặc ngưỡng cảnh báo, dùng /cancel để hủy.',
  ].join('\n');
}

export function formatUnknownText(): string {
  return [
    'Mình chưa hiểu thao tác này.',
    'Chọn nút bên dưới hoặc gõ /help để xem hướng dẫn.',
  ].join('\n');
}

export function formatKeyText(args: { keyMasked: string | null | undefined }): string {
  if (!args.keyMasked) return noKeyText();
  return ['🔑 Key đang lưu', args.keyMasked, '', 'Bấm Thay key nếu muốn cập nhật key mới.'].join('\n');
}

export function formatSettingsText(args: { alertsEnabled: boolean; alertThresholdPercent: number }): string {
  const alertLine = args.alertsEnabled
    ? `🔔 Cảnh báo quota: đang bật`
    : `🔕 Cảnh báo quota: đang tắt`;
  return [
    '⚙️ Cài đặt thông báo',
    alertLine,
    `Ngưỡng hiện tại: ${args.alertThresholdPercent}%`,
    '',
    'Chọn nút bên dưới để bật/tắt cảnh báo hoặc đổi ngưỡng.',
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
    const head = `${index + 1}. ${formatLocalDateTime(row.checkedAt, timezoneOffsetHours)}`;
    if (!row.success) return `${head}\n   ${row.maskedKey ?? '-'} - Lỗi: ${row.error ?? 'unknown error'}`;
    const quota = row.tokenLimit
      ? `${formatNumber(row.total)} / ${formatNumber(row.tokenLimit)} token (${formatPercent(row.percentOfLimit)})`
      : `${formatNumber(row.total)} token`;
    return `${head}\n   ${row.maskedKey ?? '-'} - ${formatStatusText(row.status)}\n   ${quota}`;
  });
  return ['📜 Lịch sử gần đây', '', ...lines].join('\n');
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
    ? `Đã dùng: ${formatNumber(summary.total)} / ${formatNumber(limit)} token (${formatPercent(summary.percentOfLimit)})`
    : `Đã dùng: ${formatNumber(summary.total)} token (không giới hạn)`;
  const remaining = remainingTokens(summary);
  const resetAt = summary.windowEnd ?? null;
  const imageLine = summary.imageDailyLimit
    ? `🖼 Ảnh hôm nay: ${formatNumber(summary.imageDailyUsed)} / ${formatNumber(summary.imageDailyLimit)}`
    : `🖼 Ảnh hôm nay: ${formatNumber(summary.imageDailyUsed)}`;
  const alerts = args.alertsEnabled
    ? `🔔 Cảnh báo quota: bật, ngưỡng ${args.alertThresholdPercent}%`
    : `🔕 Cảnh báo quota: đang tắt`;
  const guidance = statusGuidance(summary);
  const lines = [
    '📊 Quota của bạn',
    '',
    `🔑 ${summary.name}`,
    summary.keyMasked,
    '',
    formatStatusLabel(summary.status),
  ];
  if (guidance) lines.push(guidance);
  lines.push(usageLine);
  if (remaining != null) lines.push(`Còn lại: ${formatNumber(remaining)} token`);
  lines.push(
    '',
    imageLine,
    `🔁 Lượt gọi API: ${formatNumber(summary.req)}`,
    `🔄 Reset lúc: ${formatLocalDateTime(resetAt, args.timezoneOffsetHours)}`,
    `🕘 Lần dùng gần nhất: ${formatLocalDateTime(summary.lastUsageAt, args.timezoneOffsetHours)}`,
    '',
    alerts,
  );
  return lines.join('\n');
}
