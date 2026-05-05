import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicDisableApiKey, atomicEnableApiKey } from './atomic9router.js';

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

  it('backs up but does not rewrite when key already has desired state', () => {
    const dir = tmp9router();
    atomicDisableApiKey('b', dir, new Date('2026-01-01T00:00:00.000Z'));
    const before = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
    const res = atomicDisableApiKey('b', dir, new Date('2026-01-02T00:00:00.000Z'));
    expect(res.changed).toBe(false);
    expect(fs.existsSync(res.backupPath)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).toBe(before);
  });

  it('throws for invalid db shape or missing key', () => {
    const dir = tmp9router();
    expect(() => atomicEnableApiKey('missing', dir)).toThrow('API key not found: missing');
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ keys: [] }));
    expect(() => atomicDisableApiKey('a', dir)).toThrow('Invalid 9router db.json: apiKeys missing');
  });
});
