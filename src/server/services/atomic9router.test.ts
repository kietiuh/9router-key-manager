import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicDisableApiKey } from './atomic9router.js';

function tmp9router() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9rkm-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ apiKeys: [
    { id: 'a', name: 'A', key: 'sk-a', isActive: true },
    { id: 'b', name: 'B', key: 'sk-b', isActive: true }
  ] }, null, 2));
  return dir;
}

describe('atomicDisableApiKey', () => {
  it('backs up db.json and disables only target key', () => {
    const dir = tmp9router();
    const res = atomicDisableApiKey('b', dir, new Date('2026-01-01T00:00:00.000Z'));
    expect(res.changed).toBe(true);
    expect(fs.existsSync(res.backupPath)).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    expect(after.apiKeys.find((k: any) => k.id === 'a').isActive).toBe(true);
    expect(after.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(false);
    const backup = JSON.parse(fs.readFileSync(res.backupPath, 'utf8'));
    expect(backup.apiKeys.find((k: any) => k.id === 'b').isActive).toBe(true);
  });
});
