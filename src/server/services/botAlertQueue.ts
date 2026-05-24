import type Database from 'better-sqlite3';
import type { ApiKeyRecord, KeyUsageSummary } from '../../shared/types.js';
import { alertCategory, keyFingerprint } from '../../shared/quotaAlerts.js';

type AlertSubscriberRow = {
  telegram_user_id: number;
  chat_id: number;
  api_key: string;
  alert_threshold_percent: number;
};

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return !!row;
}

function botAlertTablesReady(db: Database.Database): boolean {
  return hasTable(db, 'bot_users') && hasTable(db, 'bot_user_settings') && hasTable(db, 'bot_alert_jobs') && hasTable(db, 'bot_quota_alerts');
}

export function enqueueBotQuotaAlertJobs(db: Database.Database, summaries: KeyUsageSummary[], keys: ApiKeyRecord[]): number {
  if (!botAlertTablesReady(db)) return 0;

  const keyByApiKey = new Map(keys.map(key => [key.key, key]));
  const summaryByKeyId = new Map(summaries.map(summary => [summary.keyId, summary]));
  const subscribers = db.prepare(`
    SELECT u.telegram_user_id, u.chat_id, u.api_key, s.alert_threshold_percent
    FROM bot_users u
    JOIN bot_user_settings s ON s.telegram_user_id = u.telegram_user_id
    WHERE s.alerts_enabled = 1 AND u.api_key IS NOT NULL AND u.api_key != ''
  `).all() as AlertSubscriberRow[];

  const alreadySent = db.prepare(`
    SELECT 1 FROM bot_quota_alerts
    WHERE telegram_user_id = ? AND key_fingerprint = ? AND reset_at = ? AND threshold_percent = ? AND category = ?
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bot_alert_jobs
      (telegram_user_id, chat_id, masked_key, key_fingerprint, reset_at, threshold_percent, category, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((rows: AlertSubscriberRow[]) => {
    let inserted = 0;
    for (const row of rows) {
      const key = keyByApiKey.get(row.api_key);
      if (!key) continue;
      const summary = summaryByKeyId.get(key.id);
      if (!summary) continue;
      const thresholdPercent = Number(row.alert_threshold_percent);
      const category = alertCategory(summary, thresholdPercent);
      if (!category) continue;
      const fingerprint = keyFingerprint(row.api_key);
      const resetAt = summary.windowEnd ?? '';
      if (alreadySent.get(row.telegram_user_id, fingerprint, resetAt, thresholdPercent, category)) continue;
      const res = insert.run(
        row.telegram_user_id,
        row.chat_id,
        summary.keyMasked,
        fingerprint,
        resetAt,
        thresholdPercent,
        category,
        JSON.stringify(summary),
      );
      inserted += Number(res.changes || 0);
    }
    return inserted;
  });

  return tx(subscribers);
}
