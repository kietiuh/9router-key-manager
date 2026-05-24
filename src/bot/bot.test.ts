import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { GoCinemaAssistantBot, type TelegramSender } from './bot.js';
import { BotDatabase, migrateBotDatabase } from './database.js';
import type { KeyUsageSummary } from '../shared/types.js';

class FakeTelegram implements TelegramSender {
  messages: Array<{ chatId: number; text: string; options?: Record<string, unknown> }> = [];

  async sendMessage(chatId: number, text: string, options?: Record<string, unknown>): Promise<void> {
    this.messages.push({ chatId, text, options });
  }
}

class FakeApi {
  calls: string[] = [];
  next: KeyUsageSummary = quotaSummary();

  async checkKey(apiKey: string): Promise<KeyUsageSummary> {
    this.calls.push(apiKey);
    return this.next;
  }
}

function makeApp() {
  const sqlite = new Database(':memory:');
  migrateBotDatabase(sqlite);
  const db = new BotDatabase(sqlite, { defaultAlertThresholdPercent: 10 });
  const telegram = new FakeTelegram();
  const api = new FakeApi();
  const app = new GoCinemaAssistantBot({ db, telegram, api, timezoneOffsetHours: 7 });
  return { app, db, telegram, api };
}

function message(text: string) {
  return {
    message: {
      message_id: 1,
      chat: { id: 99 },
      from: { id: 123, username: 'alice', first_name: 'Alice' },
      text,
    },
  };
}

function quotaSummary(overrides: Partial<KeyUsageSummary> = {}): KeyUsageSummary {
  return {
    keyId: 'k1',
    name: 'Client A',
    keyMasked: 'sk-a...test',
    isActive: true,
    status: 'ok',
    statusReason: 'Healthy',
    windowStart: '2026-05-23T17:00:00.000Z',
    windowEnd: '2026-05-24T17:00:00.000Z',
    resetPolicy: 'daily',
    expiresAt: null,
    tokenLimit: 1000,
    imageDailyLimit: null,
    imageDailyUsed: 0,
    actionOnLimit: 'disable',
    usageMultiplier: 1,
    actualPrompt: 100,
    actualCompletion: 20,
    actualTotal: 120,
    dedupedRequests: 2,
    duplicateRequests: 0,
    duplicateTokens: 0,
    req: 2,
    prompt: 100,
    completion: 20,
    total: 120,
    cost: 0,
    percentOfLimit: 12,
    firstUsageAt: '2026-05-24T01:00:00.000Z',
    lastUsageAt: '2026-05-24T02:00:00.000Z',
    models: {},
    modelUsage: [],
    ...overrides,
  };
}

describe('GoCinemaAssistantBot', () => {
  it('sends the main client menu on start', async () => {
    const { app, telegram } = makeApp();

    await app.handleUpdate(message('/start'));

    expect(telegram.messages.at(-1)?.text).toContain('GoCinema Assistant');
    expect(telegram.messages.at(-1)?.options?.reply_markup).toMatchObject({ resize_keyboard: true });
  });

  it('shows quota immediately on start when the user already saved a key', async () => {
    const { app, db, telegram, api } = makeApp();
    db.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-s...cret');

    await app.handleUpdate(message('/start'));

    expect(api.calls).toEqual(['sk-secret']);
    expect(telegram.messages.at(-1)?.text).toContain('📊 Quota của bạn');
  });

  it('guides users without a saved key to key_change', async () => {
    const { app, telegram } = makeApp();

    await app.handleUpdate(message('/quota'));

    expect(telegram.messages.at(-1)?.text).toContain('/key_change');
  });

  it('validates and stores a replacement key before showing quota', async () => {
    const { app, db, telegram, api } = makeApp();

    await app.handleUpdate(message('/key_change'));
    await app.handleUpdate(message('sk-secret'));

    expect(api.calls).toEqual(['sk-secret']);
    expect(db.getUser(123)).toMatchObject({ apiKey: 'sk-secret', keyMasked: 'sk-a...test' });
    expect(db.getUserState(123)).toBeNull();
    expect(telegram.messages.at(-1)?.text).toContain('📊 Quota của bạn');
  });

  it('checks quota for the saved key and logs history', async () => {
    const { app, db, telegram, api } = makeApp();
    db.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-s...cret');

    await app.handleUpdate(message('📊 Quota'));
    await app.handleUpdate(message('/history'));

    expect(api.calls).toEqual(['sk-secret']);
    expect(telegram.messages.at(-2)?.text).toContain('120 / 1.000 token');
    expect(telegram.messages.at(-1)?.text).toContain('📜 Lịch sử gần đây');
    expect(telegram.messages.at(-1)?.text).toContain('sk-a...test');
  });

  it('cancels pending conversation state without deleting the saved key', async () => {
    const { app, db, telegram } = makeApp();
    db.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-s...cret');

    await app.handleUpdate(message('/key_change'));
    await app.handleUpdate(message('/cancel'));

    expect(db.getUserState(123)).toBeNull();
    expect(db.getUser(123)?.apiKey).toBe('sk-secret');
    expect(telegram.messages.at(-1)?.text).toContain('Đã hủy thao tác đang nhập');
  });

  it('handles settings, alert toggles, and threshold shortcuts', async () => {
    const { app, db, telegram } = makeApp();

    await app.handleUpdate(message('/alerts_on'));
    await app.handleUpdate(message('/threshold_20'));
    await app.handleUpdate(message('/threshold_custom'));
    await app.handleUpdate(message('15'));
    await app.handleUpdate(message('/settings'));

    expect(db.getSettings(123)).toMatchObject({ alertsEnabled: true, alertThresholdPercent: 15 });
    expect(telegram.messages.at(-1)?.text).toContain('Cảnh báo quota: đang bật');
    expect(telegram.messages.at(-1)?.text).toContain('15%');
  });

  it('keeps unknown free-form text concise when no conversation is pending', async () => {
    const { app, telegram } = makeApp();

    await app.handleUpdate(message('xin chào'));

    expect(telegram.messages.at(-1)?.text).toContain('Mình chưa hiểu thao tác này');
    expect(telegram.messages.at(-1)?.text).not.toContain('/threshold_custom');
  });
});
