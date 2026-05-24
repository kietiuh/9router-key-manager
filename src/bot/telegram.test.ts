import { describe, expect, it } from 'vitest';
import { BOT_ACTIONS, commandForAction } from './actions.js';
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
      'settings',
      'cancel',
      'help',
    ]);
  });

  it('maps reply-keyboard menu labels to command handlers', () => {
    expect(commandForMenuText('📊 Quota')).toBe('/quota');
    expect(commandForMenuText('🔑 Key')).toBe('/key');
    expect(commandForMenuText('🔔 Thông báo')).toBe('/settings');
    expect(commandForMenuText('📜 Lịch sử')).toBe('/history');
    expect(commandForMenuText('⚙️ Cài đặt')).toBe('/settings');
    expect(commandForMenuText('❓ Trợ giúp')).toBe('/help');
    expect(commandForMenuText('hello')).toBeNull();
  });

  it('maps inline callback actions to command handlers', () => {
    expect(commandForAction(BOT_ACTIONS.QUOTA)).toBe('/quota');
    expect(commandForAction(BOT_ACTIONS.KEY_CHANGE)).toBe('/key_change');
    expect(commandForAction('unknown')).toBeNull();
  });

  it('sends, edits, answers callbacks, polls updates, and registers commands through Telegram Bot API', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    };
    const telegram = new TelegramClient({ token: 'token', fetchFn });

    await telegram.sendMessage(99, 'hello', { reply_markup: { inline_keyboard: [] } });
    await telegram.editMessageText(99, 10, 'updated', { reply_markup: { inline_keyboard: [] } });
    await telegram.answerCallbackQuery('callback-1');
    await telegram.getUpdates({ offset: 5, timeoutSeconds: 30 });
    await telegram.setMyCommands(BOT_COMMANDS);

    expect(calls[0]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/sendMessage',
      body: { chat_id: 99, text: 'hello', reply_markup: { inline_keyboard: [] } },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/editMessageText',
      body: { chat_id: 99, message_id: 10, text: 'updated', reply_markup: { inline_keyboard: [] } },
    });
    expect(calls[2]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/answerCallbackQuery',
      body: { callback_query_id: 'callback-1' },
    });
    expect(calls[3]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/getUpdates',
      body: { offset: 5, timeout: 30, allowed_updates: ['message', 'callback_query'] },
    });
    expect(calls[4]).toMatchObject({
      url: 'https://api.telegram.org/bottoken/setMyCommands',
      body: { commands: BOT_COMMANDS },
    });
  });

  it('ignores Telegram message-not-modified edit responses', async () => {
    const fetchFn = async () => new Response(JSON.stringify({
      ok: false,
      description: 'Bad Request: message is not modified',
    }), { status: 400 });
    const telegram = new TelegramClient({ token: 'token', fetchFn });

    await expect(telegram.editMessageText(99, 10, 'same')).resolves.toBeUndefined();
  });
});
