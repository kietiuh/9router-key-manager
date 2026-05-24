import { describe, expect, it } from 'vitest';
import { readBotConfig } from './config.js';

describe('readBotConfig', () => {
  it('requires the Telegram token', () => {
    expect(() => readBotConfig({})).toThrow('TELEGRAM_BOT_TOKEN is required');
  });

  it('reads bot runtime defaults and overrides from environment', () => {
    expect(readBotConfig({
      TELEGRAM_BOT_TOKEN: 'token',
      BOT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3039',
      BOT_POLL_TIMEOUT_SECONDS: '20',
      BOT_REQUEST_TIMEOUT_SECONDS: '8',
      BOT_ALERT_CHECK_INTERVAL_SECONDS: '120',
      BOT_ALERT_BATCH_LIMIT: '25',
      BOT_DEFAULT_ALERT_THRESHOLD_PERCENT: '15',
      BOT_TIMEZONE_OFFSET_HOURS: '7',
    })).toEqual({
      telegramBotToken: 'token',
      publicApiBaseUrl: 'http://127.0.0.1:3039',
      pollTimeoutSeconds: 20,
      requestTimeoutMs: 8000,
      alertCheckIntervalMs: 120000,
      alertBatchLimit: 25,
      defaultAlertThresholdPercent: 15,
      timezoneOffsetHours: 7,
    });
  });
});
