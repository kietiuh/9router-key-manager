import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/schema.js';
import { canonicalUsageSignatureFromRow, maintainKeyManagerStorage } from './keyManagerStorageMaintenance.js';

const tempDirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-maint-'));
  tempDirs.push(dir);
  return dir;
}

function db() {
  const d = new Database(':memory:');
  migrate(d);
  return d;
}

function insertUsage(d: Database.Database, values: Record<string, unknown>) {
  d.prepare(`INSERT INTO usage_events (
    signature, api_key, provider, connection_id, timestamp, model, cost,
    prompt_tokens, completion_tokens, total_tokens, cache_read_input_tokens, raw_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    values.signature,
    values.api_key ?? 'sk-a',
    values.provider ?? 'p',
    values.connection_id ?? 'c',
    values.timestamp ?? '2026-05-08T00:00:00.000Z',
    values.model ?? 'm',
    values.cost ?? null,
    values.prompt_tokens ?? 3,
    values.completion_tokens ?? 4,
    values.total_tokens ?? 7,
    values.cache_read_input_tokens ?? null,
    '{}',
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('keyManagerStorageMaintenance', () => {
  it('builds canonical usage signatures without cost', () => {
    const row = {
      api_key: 'sk-a',
      provider: 'p',
      connection_id: 'c',
      timestamp: '2026-05-08T00:00:00.000Z',
      model: 'm',
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      cost: 0.2,
    };

    expect(canonicalUsageSignatureFromRow(row)).toBe('sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7');
  });

  it('dry-runs duplicate cleanup without changing rows', () => {
    const d = db();
    insertUsage(d, { signature: 'sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7|0.1', cost: 0.1 });
    insertUsage(d, { signature: 'sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7|0.2', cost: 0.2 });

    const summary = maintainKeyManagerStorage(d, { apply: false });

    expect(summary.usageEvents.duplicateGroups).toBe(1);
    expect(summary.usageEvents.rowsToDelete).toBe(1);
    expect(summary.usageEvents.rowsDeleted).toBe(0);
    expect(d.prepare('SELECT COUNT(*) rows FROM usage_events').get()).toMatchObject({ rows: 2 });
  });

  it('deletes duplicate usage rows and rewrites survivor signatures', () => {
    const d = db();
    insertUsage(d, { signature: 'sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7|0.2', cost: 0.2 });
    insertUsage(d, { signature: 'sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7|0.1', cost: 0.1, cache_read_input_tokens: 2 });

    const summary = maintainKeyManagerStorage(d, { apply: true });
    const rows = d.prepare('SELECT signature, cost, cache_read_input_tokens FROM usage_events').all() as any[];

    expect(summary.usageEvents.rowsDeleted).toBe(1);
    expect(summary.usageEvents.signaturesRewritten).toBe(1);
    expect(rows).toEqual([
      {
        signature: 'sk-a|p|c|2026-05-08T00:00:00.000Z|m|3|4|7',
        cost: 0.1,
        cache_read_input_tokens: 2,
      },
    ]);
  });

  it('cleans expired public image files only when applying', () => {
    const d = db();
    const dir = tempDir();
    const expiredFile = 'expired.png';
    const activeFile = 'active.png';
    fs.writeFileSync(path.join(dir, expiredFile), 'expired');
    fs.writeFileSync(path.join(dir, activeFile), 'active');
    d.prepare(`INSERT INTO image_usage_events (kind, model, status, output_file, expires_at)
      VALUES ('public-page', 'm', 'success', ?, ?), ('public-page', 'm', 'success', ?, ?)`)
      .run(expiredFile, '2026-05-08T00:00:00.000Z', activeFile, '2026-05-10T00:00:00.000Z');

    const dry = maintainKeyManagerStorage(d, { apply: false, publicImageDir: dir, nowIso: '2026-05-09T00:00:00.000Z' });
    expect(dry.expiredPublicImages.rowsToClear).toBe(1);
    expect(fs.existsSync(path.join(dir, expiredFile))).toBe(true);

    const applied = maintainKeyManagerStorage(d, { apply: true, publicImageDir: dir, nowIso: '2026-05-09T00:00:00.000Z' });
    expect(applied.expiredPublicImages.filesDeleted).toBe(1);
    expect(fs.existsSync(path.join(dir, expiredFile))).toBe(false);
    expect(fs.existsSync(path.join(dir, activeFile))).toBe(true);
    expect(d.prepare('SELECT output_file FROM image_usage_events WHERE expires_at < ?').get('2026-05-09T00:00:00.000Z')).toMatchObject({ output_file: null });
  });
});
