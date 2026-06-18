import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AlertEngine, alertCategory, keyFingerprint } from './alerts.js';
import { BotDatabase, migrateBotDatabase } from './database.js';
import type { TelegramSender } from './bot.js';
import type { KeyUsageSummary } from '../shared/types.js';

class FakeTelegram implements TelegramSender {
  messages: Array<{ chatId: number; text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

class FakeApi {
  calls: string[] = [];
  summary = summaryWithUsage(92, '2026-05-24T17:00:00.000Z');

  async checkKey(apiKey: string): Promise<KeyUsageSummary> {
    this.calls.push(apiKey);
    return this.summary;
  }
}

function setup() {
  const sqlite = new Database(':memory:');
  migrateBotDatabase(sqlite);
  const db = new BotDatabase(sqlite, { defaultAlertThresholdPercent: 10 });
  const telegram = new FakeTelegram();
  const api = new FakeApi();
  const engine = new AlertEngine({ db, telegram, timezoneOffsetHours: 7, batchLimit: 50 });
  db.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-s...cret');
  return { db, telegram, api, engine };
}

function summaryWithUsage(percentOfLimit: number, windowEnd: string): KeyUsageSummary {
  return {
    keyId: 'k1',
    name: 'Client A',
    keyMasked: 'sk-a...test',
    isActive: true,
    status: percentOfLimit >= 100 ? 'danger' : 'warning',
    statusReason: percentOfLimit >= 100 ? 'Token limit reached' : 'Token usage above 80%',
    windowStart: '2026-05-23T17:00:00.000Z',
    windowEnd,
    resetPolicy: 'daily',
    expiresAt: null,
    tokenLimit: 1000,
    imageDailyLimit: null,
    imageDailyUsed: 0,
    actionOnLimit: 'disable',
    allowFinalFallback: true,
    usageMultiplier: 1,
    actualPrompt: 700,
    actualCompletion: 220,
    actualTotal: 920,
    dedupedRequests: 8,
    duplicateRequests: 0,
    duplicateTokens: 0,
    req: 8,
    prompt: 700,
    completion: 220,
    total: 920,
    cost: 0,
    percentOfLimit,
    firstUsageAt: '2026-05-24T01:00:00.000Z',
    lastUsageAt: '2026-05-24T02:00:00.000Z',
    models: {},
    modelUsage: [],
  };
}

describe('AlertEngine', () => {
  it('does not check public API or notify when no alert jobs are pending', async () => {
    const { api, telegram, engine } = setup();

    await engine.runOnce();

    expect(api.calls).toEqual([]);
    expect(telegram.messages).toEqual([]);
  });

  it('delivers one pending alert job and records duplicate prevention', async () => {
    const { db, api, telegram, engine } = setup();
    const summary = summaryWithUsage(92, '2026-05-24T17:00:00.000Z');
    db.enqueueAlertJob({
      telegramUserId: 123,
      chatId: 99,
      maskedKey: summary.keyMasked,
      keyFingerprint: keyFingerprint('sk-secret'),
      resetAt: summary.windowEnd ?? null,
      thresholdPercent: 10,
      category: 'token_low',
      summary,
    });

    await engine.runOnce();
    await engine.runOnce();

    expect(api.calls).toEqual([]);
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0].text).toContain('Cảnh báo quota');
    expect(telegram.messages[0].text).toContain('Còn lại: 8%');
    expect(telegram.messages[0].text).toContain('Reset lúc: 00:00 25/05/2026');
    expect(db.pendingAlertJobs(10)).toEqual([]);
  });

  it('can deliver again after the quota reset window changes', async () => {
    const { db, api, telegram, engine } = setup();
    for (const summary of [
      summaryWithUsage(92, '2026-05-24T17:00:00.000Z'),
      summaryWithUsage(93, '2026-05-25T17:00:00.000Z'),
    ]) {
      db.enqueueAlertJob({
        telegramUserId: 123,
        chatId: 99,
        maskedKey: summary.keyMasked,
        keyFingerprint: keyFingerprint('sk-secret'),
        resetAt: summary.windowEnd ?? null,
        thresholdPercent: 10,
        category: 'token_low',
        summary,
      });
    }

    await engine.runOnce();

    expect(api.calls).toEqual([]);
    expect(telegram.messages).toHaveLength(2);
  });

  it('classifies alert categories and fingerprints keys deterministically', () => {
    expect(alertCategory(summaryWithUsage(100, '2026-05-24T17:00:00.000Z'), 10)).toBe('token_empty');
    expect(alertCategory(summaryWithUsage(95, '2026-05-24T17:00:00.000Z'), 10)).toBe('token_low');
    expect(alertCategory(summaryWithUsage(70, '2026-05-24T17:00:00.000Z'), 10)).toBeNull();
    expect(keyFingerprint('sk-secret')).toBe(keyFingerprint('sk-secret'));
    expect(keyFingerprint('sk-secret')).not.toBe(keyFingerprint('sk-other'));
  });
});
