export type BotCommand = {
  command: string;
  description: string;
};

export type TelegramFetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id?: number };
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
  };
};

export const BOT_COMMANDS: BotCommand[] = [
  { command: 'start', description: 'Mở menu GoCinema Assistant' },
  { command: 'quota', description: 'Kiểm tra quota key hiện tại' },
  { command: 'check', description: 'Kiểm tra quota key hiện tại' },
  { command: 'refresh', description: 'Làm mới quota' },
  { command: 'key', description: 'Xem key đang lưu' },
  { command: 'key_change', description: 'Thay key đang lưu' },
  { command: 'alerts_on', description: 'Bật thông báo quota' },
  { command: 'alerts_off', description: 'Tắt thông báo quota' },
  { command: 'threshold_20', description: 'Báo khi quota còn 20%' },
  { command: 'threshold_10', description: 'Báo khi quota còn 10%' },
  { command: 'threshold_5', description: 'Báo khi quota còn 5%' },
  { command: 'threshold_custom', description: 'Nhập ngưỡng cảnh báo tùy chọn' },
  { command: 'history', description: 'Xem lịch sử kiểm tra gần đây' },
  { command: 'clear', description: 'Clear hội thoại hiện tại' },
  { command: 'settings', description: 'Mở cài đặt' },
  { command: 'cancel', description: 'Hủy thao tác đang nhập' },
  { command: 'help', description: 'Xem hướng dẫn' },
];

const menuCommandMap = new Map<string, string>([
  ['📊 Quota', '/quota'],
  ['🔑 Key', '/key'],
  ['🔔 Thông báo', '/settings'],
  ['🧹 Clear', '/clear'],
  ['📜 Lịch sử', '/history'],
  ['⚙️ Cài đặt', '/settings'],
  ['❓ Trợ giúp', '/help'],
]);

export function commandForMenuText(text: string): string | null {
  return menuCommandMap.get(text.trim()) ?? null;
}

export class TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly fetchFn: TelegramFetchFn;

  constructor(args: { token: string; fetchFn?: TelegramFetchFn; apiBaseUrl?: string }) {
    this.apiBaseUrl = args.apiBaseUrl ?? `https://api.telegram.org/bot${args.token}`;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async sendMessage(chatId: number, text: string, options: Record<string, unknown> = {}): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, ...options });
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  async getUpdates(args: { offset?: number; timeoutSeconds: number }): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset: args.offset,
      timeout: args.timeoutSeconds,
      allowed_updates: ['message'],
    });
  }

  private async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(`${this.apiBaseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    if (!response.ok || !body.ok) throw new Error(body.description || `Telegram API ${method} failed`);
    return body.result as T;
  }
}
