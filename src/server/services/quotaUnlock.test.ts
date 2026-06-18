import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../db/schema.js';
import type { KeyUsageSummary } from '../../shared/types.js';
import { evaluateQuotaInterceptor } from './quotaInterceptor.js';
import { maybeUnlockQuotaLockout } from './quotaUnlock.js';

function inactive9routerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-unlock-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [
    { id: 'a', name: 'A', key: 'sk-a', isActive: false },
  ] }, null, 2));
  return dir;
}

function testDb() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO key_policies (key_id, name, window_start, token_limit, reset_policy, action_on_limit) VALUES (?, ?, ?, ?, ?, ?)')
    .run('a', 'A', '2026-05-17T17:00:00.000Z', 100, 'daily', 'disable');
  db.prepare('INSERT INTO auto_disabled_keys (key_id, disabled_for_window_start, reason) VALUES (?, ?, ?)')
    .run('a', '2026-05-17T17:00:00.000Z', 'A reached quota 120/100 tokens (+20)');
  return db;
}

function summary(partial: Partial<KeyUsageSummary>): KeyUsageSummary {
  return {
    keyId: 'a',
    name: 'A',
    keyMasked: 'sk-***',
    isActive: false,
    status: 'inactive',
    statusReason: 'Key is inactive',
    windowStart: '2026-05-17T17:00:00.000Z',
    windowEnd: '2026-05-18T17:00:00.000Z',
    resetPolicy: 'daily',
    expiresAt: null,
    tokenLimit: 100,
    imageDailyLimit: null,
    imageDailyUsed: 0,
    actionOnLimit: 'disable',
    allowFinalFallback: true,
    usageMultiplier: 1,
    usageMultiplierEffectiveAt: null,
    actualPrompt: 0,
    actualCompletion: 0,
    actualTotal: 0,
    dedupedRequests: 1,
    duplicateRequests: 0,
    duplicateTokens: 0,
    req: 1,
    prompt: 0,
    completion: 0,
    total: 0,
    cost: 0,
    percentOfLimit: 0,
    firstUsageAt: null,
    lastUsageAt: null,
    models: {},
    modelUsage: [],
    ...partial,
  };
}

describe('maybeUnlockQuotaLockout', () => {
  it('clears quota lockout and re-enables storage when policy now permits usage', () => {
    const dir = inactive9routerDir();
    const db = testDb();

    const result = maybeUnlockQuotaLockout(db, summary({ total: 90, tokenLimit: 100 }), {
      baseDir: dir,
      hardDisable: true,
      now: new Date('2026-05-18T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ unlocked: true, reason: 'policy_allows' });
    expect(db.prepare('SELECT COUNT(*) n FROM auto_disabled_keys WHERE key_id = ?').get('a')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT action, message FROM audit_log WHERE key_id = ? ORDER BY id DESC LIMIT 1').get('a'))
      .toMatchObject({ action: 'quota.unlock' });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(stored.apiKeys[0].isActive).toBe(true);
    expect(evaluateQuotaInterceptor({ db, authHeader: 'Bearer sk-a', lookupKey: () => ({ id: 'a' }) }).blocked).toBe(false);
  });

  it('keeps lockout when usage still reaches the new token limit', () => {
    const dir = inactive9routerDir();
    const db = testDb();

    const result = maybeUnlockQuotaLockout(db, summary({ total: 100, tokenLimit: 100 }), {
      baseDir: dir,
      hardDisable: true,
      now: new Date('2026-05-18T10:00:00.000Z'),
    });

    expect(result).toMatchObject({ unlocked: false, reason: 'still_over_limit' });
    expect(db.prepare('SELECT COUNT(*) n FROM auto_disabled_keys WHERE key_id = ?').get('a')).toMatchObject({ n: 1 });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(stored.apiKeys[0].isActive).toBe(false);
  });
});
