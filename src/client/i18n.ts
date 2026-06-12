import type { KeyStatus } from '../shared/types';

export type Lang = 'vi' | 'en';
export type Filter = 'attention' | 'all' | KeyStatus;

export const dict = {
  en: {
    title: '9router Key Manager', subtitle: 'Daily token quota control. Set limit → watcher disables key when exceeded → daily reset can re-enable it.', refresh: 'Refresh', loginTitle: 'Admin access', password: 'Password', unlock: 'Unlock', wrong: 'Wrong password', lang: 'Language', logout: 'Logout', publicCheck: 'Public key check', check: 'Check', keyInput: 'Paste your API key', backAdmin: 'Admin login', notFound: 'Key not found', needs: 'Needs attention', tokens: 'Today tokens', req: 'Requests', active: 'Active keys', cost: 'Cost', auto: 'Auto-disable', flow: 'Recommended flow', f1: '1. Pick a key', f2: '2. Set daily limit', f3: '3. Action = disable', f4: '4. Watcher locks until next UTC+7 day', healthy: 'Everything looks healthy.', status: 'Status', name: 'Name', usage: 'Quota used', daily: 'Daily limit', window: 'Window', action: 'Action', last: 'Last use', inputTokens: 'Input tokens', outputTokens: 'Output tokens', noModels: 'No model usage yet.', quick1: 'Quick: daily limit 2× current', quick2: '50M/day + disable', limit: 'Daily/token limit', reset: 'Reset policy', expires: 'Expires at UTC+7', save: 'Save policy', saving: 'Saving…', resetNow: 'Reset manual/custom window now', usageTitle: 'Usage', total: 'Total', prompt: 'Prompt', completion: 'Completion', models: 'Models', audit: 'Audit', noAudit: 'No audit events.', setup: 'Setup needed', automaticWindow: 'Daily/monthly windows reset automatically; manual reset is only for manual/custom policies.', multiplier: 'Usage multiplier', actualTotal: 'Actual total', duplicates: 'Deduped tokens'
  },
  vi: {
    title: '9router Key Manager', subtitle: 'Quản lý quota token theo ngày. Đặt giới hạn → watcher tắt key khi vượt → qua ngày UTC+7 có thể tự bật lại.', refresh: 'Làm mới', loginTitle: 'Truy cập quản trị', password: 'Mật khẩu', unlock: 'Mở khóa', wrong: 'Sai mật khẩu', lang: 'Ngôn ngữ', logout: 'Đăng xuất', publicCheck: 'Kiểm tra key công khai', check: 'Kiểm tra', keyInput: 'Nhập API key của bạn', backAdmin: 'Đăng nhập admin', notFound: 'Không tìm thấy key', needs: 'Cần chú ý', tokens: 'Token hôm nay', req: 'Số request', active: 'Key đang bật', cost: 'Chi phí', auto: 'Tự tắt key', flow: 'Flow khuyến nghị', f1: '1. Chọn key', f2: '2. Đặt daily limit', f3: '3. Action = disable', f4: '4. Watcher khóa tới ngày UTC+7 tiếp theo', healthy: 'Mọi thứ ổn.', status: 'Trạng thái', name: 'Tên', usage: 'Đã dùng quota', daily: 'Giới hạn/ngày', window: 'Chu kỳ', action: 'Hành động', last: 'Dùng gần nhất', inputTokens: 'Input token', outputTokens: 'Output token', noModels: 'Chưa có lượt dùng model.', quick1: 'Nhanh: limit/ngày = 2× hiện tại', quick2: '50M/ngày + disable', limit: 'Giới hạn token/ngày', reset: 'Chính sách reset', expires: 'Hết hạn lúc UTC+7', save: 'Lưu policy', saving: 'Đang lưu…', resetNow: 'Reset chu kỳ manual/custom', usageTitle: 'Sử dụng', total: 'Tổng', prompt: 'Prompt', completion: 'Completion', models: 'Models', audit: 'Audit', noAudit: 'Chưa có audit.', setup: 'Cần setup', automaticWindow: 'Chu kỳ daily/monthly tự reset; reset thủ công chỉ áp dụng cho manual/custom.', multiplier: 'Hệ số usage', actualTotal: 'Token thực tế', duplicates: 'Token đã khử trùng lặp'
  }
} as const;

export function filterLabel(filter: Filter, lang: Lang) {
  const labels: Record<Lang, Record<Filter, string>> = {
    en: { attention: 'Needs attention', all: 'All', danger: 'Danger', warning: 'Warning', unlimited: 'Unlimited', expired: 'Expired', inactive: 'Inactive', ok: 'OK' },
    vi: { attention: 'Cần chú ý', all: 'Tất cả', danger: 'Nguy hiểm', warning: 'Cảnh báo', unlimited: 'Chưa giới hạn', expired: 'Hết hạn', inactive: 'Đã tắt', ok: 'Ổn' }
  };
  return labels[lang][filter];
}

export function statusLabel(status: KeyStatus, lang: Lang) {
  return filterLabel(status, lang);
}

export function recommendation(status: KeyStatus, actionOnLimit: 'alert' | 'disable' | 'none', hardDisable: boolean | undefined, lang: Lang) {
  if (lang === 'vi') {
    if (status === 'danger') return hardDisable && actionOnLimit === 'disable' ? 'Đã/ sẽ bị khóa tới chu kỳ ngày tiếp theo.' : 'Tăng limit hoặc đặt action = disable.';
    if (status === 'warning') return 'Theo dõi usage; cân nhắc tăng daily limit.';
    if (status === 'unlimited') return 'Nên đặt giới hạn token/ngày để tránh dùng quá mức.';
    if (status === 'expired') return 'Gia hạn hoặc thay key này.';
    if (status === 'inactive') return 'Key inactive; không nên có traffic.';
    return 'Không cần hành động.';
  }
  if (status === 'danger') return hardDisable && actionOnLimit === 'disable' ? 'Locked until next daily reset if watcher runs.' : 'Raise limit or set action to disable.';
  if (status === 'warning') return 'Watch usage; consider raising the daily limit.';
  if (status === 'unlimited') return 'Set a daily token limit to prevent runaway usage.';
  if (status === 'expired') return 'Extend expiry or replace this key.';
  if (status === 'inactive') return 'Inactive; no traffic should use this key.';
  return 'No action needed.';
}
