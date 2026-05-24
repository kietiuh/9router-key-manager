export type BotConfig = {
  telegramBotToken: string;
  publicApiBaseUrl: string;
  pollTimeoutSeconds: number;
  requestTimeoutMs: number;
  alertCheckIntervalMs: number;
  alertBatchLimit: number;
  defaultAlertThresholdPercent: number;
  timezoneOffsetHours: number;
};

export function readBotConfig(env: Record<string, string | undefined> = process.env): BotConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
  return {
    telegramBotToken: token,
    publicApiBaseUrl: env.BOT_PUBLIC_API_BASE_URL?.trim() || 'http://127.0.0.1:3000',
    pollTimeoutSeconds: readInt(env.BOT_POLL_TIMEOUT_SECONDS, 30),
    requestTimeoutMs: readInt(env.BOT_REQUEST_TIMEOUT_SECONDS, 15) * 1000,
    alertCheckIntervalMs: readInt(env.BOT_ALERT_CHECK_INTERVAL_SECONDS, 300) * 1000,
    alertBatchLimit: readInt(env.BOT_ALERT_BATCH_LIMIT, 50),
    defaultAlertThresholdPercent: readInt(env.BOT_DEFAULT_ALERT_THRESHOLD_PERCENT, 10),
    timezoneOffsetHours: readInt(env.BOT_TIMEZONE_OFFSET_HOURS, 7),
  };
}

function readInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}
