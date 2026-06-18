import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { BotDatabase, migrateBotDatabase } from '../../bot/database.js';
import { enqueueBotQuotaAlertJobs } from './botAlertQueue.js';
import type { ApiKeyRecord, KeyUsageSummary } from '../../shared/types.js';
import { keyFingerprint } from '../../shared/quotaAlerts.js';

function summary(partial: Partial<KeyUsageSummary> = {}): KeyUsageSummary {
  return {
    keyId: 'a',
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
    allowFinalFallback: true,
    usageMultiplier: 1,
    usageMultiplierEffectiveAt: null,
    actualPrompt: 400,
    actualCompletion: 200,
    actualTotal: 600,
    dedupedRequests: 3,
    duplicateRequests: 0,
    duplicateTokens: 0,
    req: 3,
    prompt: 400,
    completion: 200,
    total: 600,
    cost: 0,
    percentOfLimit: 60,
    firstUsageAt: '2026-05-24T01:00:00.000Z',
    lastUsageAt: '2026-05-24T02:00:00.000Z',
    models: {},
    modelUsage: [],
    ...partial,
  };
}

function key(partial: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return { id: 'a', name: 'Client A', key: 'sk-secret', isActive: true, ...partial };
}

describe('enqueueBotQuotaAlertJobs', () => {
  it('creates the alert job table from the server migration', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);

    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_alert_jobs'").get() as { name?: string } | undefined;
    expect(row?.name).toBe('bot_alert_jobs');
  });

  it('enqueues one job for a subscribed user whose remaining quota is within threshold', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);
    migrateBotDatabase(sqlite);
    const botDb = new BotDatabase(sqlite, { defaultAlertThresholdPercent: 10 });
    botDb.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-a...test');
    botDb.setAlertSettings(123, true, 40);

    const enqueued = enqueueBotQuotaAlertJobs(sqlite, [summary()], [key()]);

    expect(enqueued).toBe(1);
    const jobs = botDb.pendingAlertJobs(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      telegramUserId: 123,
      chatId: 99,
      category: 'token_low',
      thresholdPercent: 40,
    });
    expect(jobs[0].summary.keyId).toBe('a');
  });

  it('does not enqueue duplicate jobs or jobs for users already alerted', () => {
    const sqlite = new Database(':memory:');
    migrate(sqlite);
    migrateBotDatabase(sqlite);
    const botDb = new BotDatabase(sqlite, { defaultAlertThresholdPercent: 10 });
    const current = summary();
    botDb.saveUserKey({ id: 123, username: 'alice' }, 99, 'sk-secret', 'sk-a...test');
    botDb.setAlertSettings(123, true, 40);

    expect(enqueueBotQuotaAlertJobs(sqlite, [current], [key()])).toBe(1);
    expect(enqueueBotQuotaAlertJobs(sqlite, [current], [key()])).toBe(0);
    botDb.recordAlertSent({
      telegramUserId: 123,
      maskedKey: current.keyMasked,
      keyFingerprint: keyFingerprint('sk-secret'),
      resetAt: current.windowEnd ?? null,
      thresholdPercent: 40,
      category: 'token_low',
    });
    sqlite.prepare("DELETE FROM bot_alert_jobs WHERE status = 'pending'").run();

    expect(enqueueBotQuotaAlertJobs(sqlite, [current], [key()])).toBe(0);
  });
});
