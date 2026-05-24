import type Database from 'better-sqlite3';
import type { KeyUsageSummary } from '../shared/types.js';

export type BotUserIdentity = {
  id: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export type BotUser = {
  telegramUserId: number;
  chatId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  apiKey: string | null;
  keyMasked: string | null;
};

export type BotSettings = {
  telegramUserId: number;
  alertsEnabled: boolean;
  alertThresholdPercent: number;
};

export type QuotaCheckRow = {
  id: number;
  telegramUserId: number;
  source: string;
  success: boolean;
  maskedKey: string | null;
  status: string | null;
  total: number | null;
  tokenLimit: number | null;
  percentOfLimit: number | null;
  resetAt: string | null;
  error: string | null;
  checkedAt: string;
};

export type AlertUser = BotUser & BotSettings;

export type AlertCategory = 'token_low' | 'token_empty' | 'key_inactive' | 'key_expired';

export type BotAlertJob = {
  id: number;
  telegramUserId: number;
  chatId: number;
  maskedKey: string;
  keyFingerprint: string;
  resetAt: string | null;
  thresholdPercent: number;
  category: AlertCategory;
  summary: KeyUsageSummary;
  attempts: number;
  createdAt: string;
};

export function migrateBotDatabase(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_user_id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      api_key TEXT,
      key_masked TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bot_users_api_key ON bot_users (api_key);
    CREATE TABLE IF NOT EXISTS bot_user_settings (
      telegram_user_id INTEGER PRIMARY KEY,
      alerts_enabled INTEGER NOT NULL DEFAULT 0,
      alert_threshold_percent INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bot_user_settings_alerts ON bot_user_settings (alerts_enabled, telegram_user_id);
    CREATE TABLE IF NOT EXISTS bot_user_states (
      telegram_user_id INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bot_quota_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      success INTEGER NOT NULL,
      masked_key TEXT,
      status TEXT,
      total INTEGER,
      token_limit INTEGER,
      percent_of_limit REAL,
      reset_at TEXT,
      error TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bot_quota_checks_user_id ON bot_quota_checks (telegram_user_id, id DESC);
    CREATE TABLE IF NOT EXISTS bot_quota_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      masked_key TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      reset_at TEXT NOT NULL,
      threshold_percent INTEGER NOT NULL,
      category TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      UNIQUE (telegram_user_id, key_fingerprint, reset_at, threshold_percent, category)
    );
    CREATE TABLE IF NOT EXISTS bot_alert_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      masked_key TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      reset_at TEXT NOT NULL,
      threshold_percent INTEGER NOT NULL,
      category TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      UNIQUE (telegram_user_id, key_fingerprint, reset_at, threshold_percent, category)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_alert_jobs_pending ON bot_alert_jobs (status, id);
  `);
}

export class BotDatabase {
  constructor(
    private readonly db: Database.Database,
    private readonly options: { defaultAlertThresholdPercent: number },
  ) {}

  saveUserIdentity(user: BotUserIdentity, chatId: number): void {
    this.db.prepare(`
      INSERT INTO bot_users (telegram_user_id, chat_id, username, first_name, last_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = CURRENT_TIMESTAMP
    `).run(user.id, chatId, user.username ?? null, user.firstName ?? null, user.lastName ?? null);
  }

  saveUserKey(user: BotUserIdentity, chatId: number, apiKey: string, keyMasked: string): void {
    this.db.prepare(`
      INSERT INTO bot_users (telegram_user_id, chat_id, username, first_name, last_name, api_key, key_masked)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        api_key = excluded.api_key,
        key_masked = excluded.key_masked,
        updated_at = CURRENT_TIMESTAMP
    `).run(user.id, chatId, user.username ?? null, user.firstName ?? null, user.lastName ?? null, apiKey, keyMasked);
  }

  getUser(telegramUserId: number): BotUser | null {
    const row = this.db.prepare('SELECT * FROM bot_users WHERE telegram_user_id = ?').get(telegramUserId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapUser(row);
  }

  getSettings(telegramUserId: number): BotSettings {
    this.db.prepare(`
      INSERT INTO bot_user_settings (telegram_user_id, alert_threshold_percent)
      VALUES (?, ?)
      ON CONFLICT(telegram_user_id) DO NOTHING
    `).run(telegramUserId, this.options.defaultAlertThresholdPercent);
    const row = this.db.prepare('SELECT * FROM bot_user_settings WHERE telegram_user_id = ?').get(telegramUserId) as Record<string, unknown>;
    return mapSettings(row);
  }

  setAlertSettings(telegramUserId: number, alertsEnabled: boolean, thresholdPercent?: number): BotSettings {
    const current = this.getSettings(telegramUserId);
    const threshold = thresholdPercent ?? current.alertThresholdPercent;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error('alert threshold must be an integer from 1 to 100');
    this.db.prepare(`
      UPDATE bot_user_settings
      SET alerts_enabled = ?, alert_threshold_percent = ?, updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
    `).run(alertsEnabled ? 1 : 0, threshold, telegramUserId);
    return this.getSettings(telegramUserId);
  }

  setUserState(telegramUserId: number, state: string): void {
    this.db.prepare(`
      INSERT INTO bot_user_states (telegram_user_id, state)
      VALUES (?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET state = excluded.state, updated_at = CURRENT_TIMESTAMP
    `).run(telegramUserId, state);
  }

  getUserState(telegramUserId: number): string | null {
    const row = this.db.prepare('SELECT state FROM bot_user_states WHERE telegram_user_id = ?').get(telegramUserId) as { state?: string } | undefined;
    return row?.state ?? null;
  }

  clearUserState(telegramUserId: number): void {
    this.db.prepare('DELETE FROM bot_user_states WHERE telegram_user_id = ?').run(telegramUserId);
  }

  logQuotaCheck(args: {
    telegramUserId: number;
    source: 'manual' | 'alert';
    success: boolean;
    maskedKey?: string | null;
    status?: string | null;
    total?: number | null;
    tokenLimit?: number | null;
    percentOfLimit?: number | null;
    resetAt?: string | null;
    error?: string | null;
    checkedAt?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO bot_quota_checks
        (telegram_user_id, source, success, masked_key, status, total, token_limit, percent_of_limit, reset_at, error, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.telegramUserId,
      args.source,
      args.success ? 1 : 0,
      args.maskedKey ?? null,
      args.status ?? null,
      args.total ?? null,
      args.tokenLimit ?? null,
      args.percentOfLimit ?? null,
      args.resetAt ?? null,
      args.error ?? null,
      args.checkedAt ?? new Date().toISOString(),
    );
  }

  recentQuotaChecks(telegramUserId: number, limit: number): QuotaCheckRow[] {
    const rows = this.db.prepare('SELECT * FROM bot_quota_checks WHERE telegram_user_id = ? ORDER BY id DESC LIMIT ?').all(telegramUserId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapQuotaCheck);
  }

  usersWithAlertsEnabled(limit: number): AlertUser[] {
    const rows = this.db.prepare(`
      SELECT u.*, s.alerts_enabled, s.alert_threshold_percent
      FROM bot_users u
      JOIN bot_user_settings s ON s.telegram_user_id = u.telegram_user_id
      WHERE s.alerts_enabled = 1 AND u.api_key IS NOT NULL AND u.api_key != ''
      ORDER BY u.updated_at ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(row => ({ ...mapUser(row), ...mapSettings(row) }));
  }

  hasSentAlert(telegramUserId: number, keyFingerprint: string, resetAt: string | null, thresholdPercent: number, category: AlertCategory): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM bot_quota_alerts
      WHERE telegram_user_id = ? AND key_fingerprint = ? AND reset_at = ? AND threshold_percent = ? AND category = ?
    `).get(telegramUserId, keyFingerprint, resetAt ?? '', thresholdPercent, category);
    return !!row;
  }

  recordAlertSent(args: {
    telegramUserId: number;
    maskedKey: string;
    keyFingerprint: string;
    resetAt: string | null;
    thresholdPercent: number;
    category: AlertCategory;
    sentAt?: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO bot_quota_alerts
        (telegram_user_id, masked_key, key_fingerprint, reset_at, threshold_percent, category, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(args.telegramUserId, args.maskedKey, args.keyFingerprint, args.resetAt ?? '', args.thresholdPercent, args.category, args.sentAt ?? new Date().toISOString());
  }

  enqueueAlertJob(args: {
    telegramUserId: number;
    chatId: number;
    maskedKey: string;
    keyFingerprint: string;
    resetAt: string | null;
    thresholdPercent: number;
    category: AlertCategory;
    summary: KeyUsageSummary;
  }): boolean {
    const res = this.db.prepare(`
      INSERT OR IGNORE INTO bot_alert_jobs
        (telegram_user_id, chat_id, masked_key, key_fingerprint, reset_at, threshold_percent, category, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.telegramUserId,
      args.chatId,
      args.maskedKey,
      args.keyFingerprint,
      args.resetAt ?? '',
      args.thresholdPercent,
      args.category,
      JSON.stringify(args.summary),
    );
    return Number(res.changes || 0) > 0;
  }

  pendingAlertJobs(limit: number): BotAlertJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM bot_alert_jobs
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(mapAlertJob);
  }

  markAlertJobSent(id: number, sentAt = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE bot_alert_jobs
      SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sentAt, id);
  }

  markAlertJobFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE bot_alert_jobs
      SET attempts = attempts + 1,
          last_error = ?,
          status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(error, id);
  }
}

function mapUser(row: Record<string, unknown>): BotUser {
  return {
    telegramUserId: Number(row.telegram_user_id),
    chatId: Number(row.chat_id),
    username: row.username == null ? null : String(row.username),
    firstName: row.first_name == null ? null : String(row.first_name),
    lastName: row.last_name == null ? null : String(row.last_name),
    apiKey: row.api_key == null ? null : String(row.api_key),
    keyMasked: row.key_masked == null ? null : String(row.key_masked),
  };
}

function mapSettings(row: Record<string, unknown>): BotSettings {
  return {
    telegramUserId: Number(row.telegram_user_id),
    alertsEnabled: Number(row.alerts_enabled) === 1,
    alertThresholdPercent: Number(row.alert_threshold_percent),
  };
}

function mapQuotaCheck(row: Record<string, unknown>): QuotaCheckRow {
  return {
    id: Number(row.id),
    telegramUserId: Number(row.telegram_user_id),
    source: String(row.source),
    success: Number(row.success) === 1,
    maskedKey: row.masked_key == null ? null : String(row.masked_key),
    status: row.status == null ? null : String(row.status),
    total: row.total == null ? null : Number(row.total),
    tokenLimit: row.token_limit == null ? null : Number(row.token_limit),
    percentOfLimit: row.percent_of_limit == null ? null : Number(row.percent_of_limit),
    resetAt: row.reset_at == null ? null : String(row.reset_at),
    error: row.error == null ? null : String(row.error),
    checkedAt: String(row.checked_at),
  };
}

function mapAlertJob(row: Record<string, unknown>): BotAlertJob {
  return {
    id: Number(row.id),
    telegramUserId: Number(row.telegram_user_id),
    chatId: Number(row.chat_id),
    maskedKey: String(row.masked_key),
    keyFingerprint: String(row.key_fingerprint),
    resetAt: row.reset_at == null || row.reset_at === '' ? null : String(row.reset_at),
    thresholdPercent: Number(row.threshold_percent),
    category: String(row.category) as AlertCategory,
    summary: JSON.parse(String(row.summary_json)) as KeyUsageSummary,
    attempts: Number(row.attempts ?? 0),
    createdAt: String(row.created_at),
  };
}
