import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { createPublicImageStore } from './publicImageStore.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-images-'));
  tempDirs.push(dir);
  return dir;
}

function db() {
  const d = new Database(':memory:');
  migrate(d);
  return d;
}

describe('public image store', () => {
  it('counts successful public page images for the current Vietnam day', () => {
    const d = db();
    const store = createPublicImageStore({ db: d, publicImageDir: tempDir(), publicImageTtlMs: 60_000 });

    store.recordImageUsage({ keyId: 'key-a', apiKey: 'sk-a', kind: 'public-page', model: 'm', status: 'success', imageCount: 2 });
    store.recordImageUsage({ keyId: 'key-a', apiKey: 'sk-a', kind: 'public-page', model: 'm', status: 'error', imageCount: 5 });

    expect(store.dailyImageUsageForKey('key-a')).toBe(2);
  });

  it('throws when the image daily quota has been reached', () => {
    const d = db();
    d.prepare('INSERT INTO key_policies (key_id, name, window_start, image_daily_limit) VALUES (?, ?, ?, ?)')
      .run('key-a', 'A', '2026-06-04T00:00:00.000Z', 1);
    const store = createPublicImageStore({ db: d, publicImageDir: tempDir(), publicImageTtlMs: 60_000 });
    store.recordImageUsage({ keyId: 'key-a', apiKey: 'sk-a', kind: 'public-page', model: 'm', status: 'success', imageCount: 1 });

    expect(() => store.ensureImageDailyQuota('key-a')).toThrow('image daily limit reached (1/1)');
  });

  it('saves public images and returns downloadable history', () => {
    const d = db();
    const dir = tempDir();
    const store = createPublicImageStore({ db: d, publicImageDir: dir, publicImageTtlMs: 60_000 });
    const saved = store.savePublicImage(Buffer.from('png').toString('base64'));
    store.recordImageUsage({ keyId: 'key-a', apiKey: 'sk-a', kind: 'public-page', model: 'm', status: 'success', imageCount: 1, outputFile: saved.fileName, bytes: 3, expiresAt: saved.expiresAt });

    const history = store.imageHistoryForKey('key-a');
    const downloaded = store.readPublicImageForKey(Number(history.images[0].id), 'key-a');

    expect(history.images).toHaveLength(1);
    expect(downloaded).toMatchObject({ image: Buffer.from('png').toString('base64'), mimeType: 'image/png', bytes: 3 });
    expect(fs.existsSync(path.join(dir, saved.fileName))).toBe(true);
  });
});
