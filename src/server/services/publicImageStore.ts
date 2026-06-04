import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ImageUsageInput = {
  keyId?: string;
  apiKey?: string;
  kind: string;
  model: string;
  size?: string;
  promptPreview?: string;
  promptHash?: string;
  inputFile?: string;
  outputFile?: string;
  drivePath?: string;
  status: string;
  error?: string;
  imageCount?: number;
  bytes?: number;
  estimatedPromptTokens?: number;
  estimatedCompletionTokens?: number;
  estimatedTotalTokens?: number;
  usageEventSignature?: string;
  expiresAt?: string;
};

export type PublicImageDownload = {
  image: string;
  mimeType: 'image/png';
  filename: string;
  bytes: number;
  expiresAt?: string | null;
};

export type PublicImageStoreOptions = {
  db: Database.Database;
  publicImageDir: string;
  publicImageTtlMs: number;
};

function vietnamDayString(date = new Date()) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function createPublicImageStore(options: PublicImageStoreOptions) {
  const { db, publicImageDir, publicImageTtlMs } = options;
  fs.mkdirSync(publicImageDir, { recursive: true, mode: 0o700 });

  const publicImagePath = (fileName: string) => path.join(publicImageDir, path.basename(fileName));

  const cleanupExpiredPublicImages = () => {
    const now = new Date().toISOString();
    const rows = db.prepare("SELECT output_file FROM image_usage_events WHERE output_file IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as Array<{ output_file: string }>;
    for (const row of rows) {
      try {
        fs.unlinkSync(publicImagePath(row.output_file));
      } catch {
        // Expired image cleanup must not break request handling.
      }
    }
    db.prepare("UPDATE image_usage_events SET output_file = NULL WHERE output_file IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
  };

  const dailyImageUsageForKey = (keyId: string) => {
    const today = vietnamDayString();
    const row = db.prepare("SELECT COALESCE(SUM(image_count),0) images FROM image_usage_events WHERE key_id = ? AND kind = 'public-page' AND status = 'success' AND date(datetime(created_at, '+7 hours')) = ?").get(keyId, today) as { images?: number } | undefined;
    return Number(row?.images || 0);
  };

  const ensureImageDailyQuota = (keyId: string) => {
    const policy = db.prepare('SELECT image_daily_limit FROM key_policies WHERE key_id = ?').get(keyId) as { image_daily_limit?: number | null } | undefined;
    const limit = policy?.image_daily_limit == null ? null : Number(policy.image_daily_limit);
    if (!limit) return;
    const used = dailyImageUsageForKey(keyId);
    if (used >= limit) {
      const err = new Error(`image daily limit reached (${used}/${limit})`) as Error & { statusCode?: number };
      err.statusCode = 429;
      throw err;
    }
  };

  const imageUsageSummary = () => {
    const today = vietnamDayString();
    const rows = db.prepare('SELECT * FROM image_usage_events ORDER BY id DESC LIMIT 200').all() as unknown[];
    const total = db.prepare("SELECT COALESCE(SUM(image_count),0) images, COALESCE(SUM(bytes),0) bytes, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success, SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) errors FROM image_usage_events").get() as { images?: number; bytes?: number; success?: number; errors?: number };
    const todayImages = db.prepare("SELECT COALESCE(SUM(image_count),0) images FROM image_usage_events WHERE date(datetime(created_at, '+7 hours')) = ?").get(today) as { images?: number };
    return { todayImages: Number(todayImages.images || 0), totalImages: Number(total.images || 0), success: Number(total.success || 0), errors: Number(total.errors || 0), bytes: Number(total.bytes || 0), events: rows };
  };

  const recordImageUsage = (body: ImageUsageInput) => {
    const res = db.prepare(`INSERT INTO image_usage_events (key_id, api_key, kind, model, size, prompt_preview, prompt_hash, input_file, output_file, drive_path, status, error, image_count, bytes, estimated_prompt_tokens, estimated_completion_tokens, estimated_total_tokens, usage_event_signature, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      body.keyId ?? null,
      body.apiKey ?? null,
      body.kind,
      body.model,
      body.size ?? null,
      body.promptPreview ?? null,
      body.promptHash ?? null,
      body.inputFile ?? null,
      body.outputFile ?? null,
      body.drivePath ?? null,
      body.status,
      body.error ?? null,
      body.imageCount ?? 1,
      body.bytes ?? null,
      body.estimatedPromptTokens ?? null,
      body.estimatedCompletionTokens ?? null,
      body.estimatedTotalTokens ?? null,
      body.usageEventSignature ?? null,
      body.expiresAt ?? null,
    );
    return { ok: true, id: Number(res.lastInsertRowid) };
  };

  const recordImageProxyUsage = (body: ImageUsageInput) => {
    try {
      recordImageUsage(body);
    } catch {
      // Usage logging must not break proxy behavior.
    }
  };

  const savePublicImage = (imageBase64: string) => {
    cleanupExpiredPublicImages();
    const fileName = `${crypto.randomUUID()}.png`;
    fs.writeFileSync(publicImagePath(fileName), Buffer.from(imageBase64, 'base64'), { mode: 0o600 });
    return { fileName, expiresAt: new Date(Date.now() + publicImageTtlMs).toISOString() };
  };

  const imageHistoryForKey = (keyId: string) => {
    cleanupExpiredPublicImages();
    const now = new Date().toISOString();
    const rows = db.prepare(`SELECT id, model, size, prompt_preview, status, image_count, bytes, estimated_total_tokens, output_file, expires_at, created_at FROM image_usage_events WHERE key_id = ? AND kind = 'public-page' AND status = 'success' AND output_file IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 50`).all(keyId, now) as Array<{
      id: number;
      model: string;
      size: string | null;
      prompt_preview: string | null;
      bytes: number | null;
      estimated_total_tokens: number | null;
      created_at: string;
      expires_at: string | null;
    }>;
    return {
      images: rows.map(r => ({
        id: r.id,
        model: r.model,
        size: r.size,
        promptPreview: r.prompt_preview,
        bytes: r.bytes,
        estimatedTotalTokens: r.estimated_total_tokens,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    };
  };

  const readPublicImageForKey = (id: number, keyId: string): PublicImageDownload | null => {
    cleanupExpiredPublicImages();
    const row = db.prepare(`SELECT output_file, bytes, expires_at FROM image_usage_events WHERE id = ? AND key_id = ? AND kind = 'public-page' AND status = 'success'`).get(id, keyId) as { output_file?: string | null; bytes?: number | null; expires_at?: string | null } | undefined;
    if (!row?.output_file) return null;
    if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;
    const file = publicImagePath(row.output_file);
    if (!fs.existsSync(file)) return null;
    return {
      image: fs.readFileSync(file).toString('base64'),
      mimeType: 'image/png',
      filename: `gocinema-image-${id}.png`,
      bytes: row.bytes ?? fs.statSync(file).size,
      expiresAt: row.expires_at,
    };
  };

  return {
    cleanupExpiredPublicImages,
    dailyImageUsageForKey,
    ensureImageDailyQuota,
    imageUsageSummary,
    recordImageUsage,
    recordImageProxyUsage,
    savePublicImage,
    imageHistoryForKey,
    readPublicImageForKey,
  };
}
