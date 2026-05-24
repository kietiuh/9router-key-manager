import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { BotDatabase, migrateBotDatabase } from './database.js';

function memoryDb() {
  const db = new Database(':memory:');
  migrateBotDatabase(db);
  return new BotDatabase(db, { defaultAlertThresholdPercent: 10 });
}

describe('bot database', () => {
  it('runs migrations idempotently', () => {
    const db = new Database(':memory:');
    migrateBotDatabase(db);
    migrateBotDatabase(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bot_%' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map(row => row.name)).toEqual([
      'bot_alert_jobs',
      'bot_quota_alerts',
      'bot_quota_checks',
      'bot_user_settings',
      'bot_user_states',
      'bot_users',
    ]);
  });

  it('creates default user settings with alerts disabled', () => {
    const db = memoryDb();

    expect(db.getSettings(123)).toEqual({
      telegramUserId: 123,
      alertsEnabled: false,
      alertThresholdPercent: 10,
    });
  });

  it('stores the current user key and pending state', () => {
    const db = memoryDb();

    db.saveUserKey({ id: 123, username: 'alice', firstName: 'Alice', lastName: 'Nguyen' }, 99, 'sk-secret', 'sk-s...cret');
    db.setUserState(123, 'awaiting_key');

    expect(db.getUser(123)).toMatchObject({
      telegramUserId: 123,
      chatId: 99,
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Nguyen',
      apiKey: 'sk-secret',
      keyMasked: 'sk-s...cret',
    });
    expect(db.getUserState(123)).toBe('awaiting_key');

    db.clearUserState(123);
    expect(db.getUserState(123)).toBeNull();
  });

  it('logs recent quota checks newest first', () => {
    const db = memoryDb();

    db.logQuotaCheck({
      telegramUserId: 123,
      source: 'manual',
      success: true,
      maskedKey: 'sk-a...1',
      status: 'ok',
      total: 100,
      tokenLimit: 1000,
      percentOfLimit: 10,
      resetAt: '2026-05-24T17:00:00.000Z',
      checkedAt: '2026-05-24T01:00:00.000Z',
    });
    db.logQuotaCheck({
      telegramUserId: 123,
      source: 'manual',
      success: false,
      maskedKey: 'sk-a...1',
      error: 'key not found',
      checkedAt: '2026-05-24T02:00:00.000Z',
    });

    expect(db.recentQuotaChecks(123, 5)).toMatchObject([
      { success: false, error: 'key not found' },
      { success: true, status: 'ok', total: 100, tokenLimit: 1000, percentOfLimit: 10 },
    ]);
  });

  it('tracks alert duplicates by user, key, reset, threshold, and category', () => {
    const db = memoryDb();

    expect(db.hasSentAlert(123, 'fp-a', '2026-05-24T17:00:00.000Z', 10, 'token_low')).toBe(false);
    db.recordAlertSent({
      telegramUserId: 123,
      maskedKey: 'sk-a...1',
      keyFingerprint: 'fp-a',
      resetAt: '2026-05-24T17:00:00.000Z',
      thresholdPercent: 10,
      category: 'token_low',
      sentAt: '2026-05-24T01:00:00.000Z',
    });

    expect(db.hasSentAlert(123, 'fp-a', '2026-05-24T17:00:00.000Z', 10, 'token_low')).toBe(true);
    expect(db.hasSentAlert(123, 'fp-a', '2026-05-25T17:00:00.000Z', 10, 'token_low')).toBe(false);
  });
});
