import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS, commandForMenuText, TelegramClient } from './telegram.js';

describe('telegram command metadata', () => {
  it('registers slash commands that Telegram can suggest when users type slash', () => {
    expect(BOT_COMMANDS.map(command => command.command)).toEqual([
      'start',
      'quota',
      'check',
      'refresh',
      'key',
      'key_change',
      'alerts_on',
      'alerts_off',
      'threshold_20',
      'threshold_10',
      'threshold_5',
      'threshold_custom',
      'history',
      'clear',
      'settings',
      'cancel',
      'help',
    ]);
  });

  it('maps reply-keyboard menu labels to command handlers', () => {
    expect(commandForMenuText('📊 Quota')).toBe('/quota');
    expect(commandForMenuText('🔑 Key')).toBe('/key');
    expect(commandForMenuText('🔔 Thông báo')).toBe('/settings');
    expect(commandForMenuText('🧹 Clear')).toBe('/clear');
    expect(commandForMenuText('📜 Lịch sử')).toBe('/history');
    expect(commandForMenuText('⚙️ Cài đặt')).toBe('/settings');
    expect(commandForMenuText('❓ Trợ giúp')).toBe('/help');
    expect(commandForMenuText('hello')).toBeNull();
  });

  it('sends messages and registers commands through Telegram Bot API', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    };
    const telegram = new TelegramClient({ token: 'token', fetchFn });

    await telegram.sendMessage(99, 'hello', { reply_markup: { resize_keyboard: true } });
    await telegram.setMyCommands(BOT_COMMANDS);

    expect(calls[0]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/sendMessage',
      body: { chat_id: 99, text: 'hello', reply_markup: { resize_keyboard: true } },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/setMyCommands',
      body: { commands: BOT_COMMANDS },
    });
  });
});
