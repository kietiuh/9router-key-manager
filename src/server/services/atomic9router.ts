import fs from 'node:fs';
import path from 'node:path';
import { dbJsonPath } from '../parsers/paths.js';

export type ToggleResult = { changed: boolean; backupPath: string; dbPath: string; isActive: boolean };

function atomicToggleApiKey(keyId: string, isActive: boolean, baseDir?: string, now = new Date()): ToggleResult {
  const target = dbJsonPath(baseDir);
  const original = fs.readFileSync(target, 'utf8');
  const parsed = JSON.parse(original);
  if (!Array.isArray(parsed.apiKeys)) throw new Error('Invalid 9router db.json: apiKeys missing');
  const key = parsed.apiKeys.find((k: any) => k.id === keyId);
  if (!key) throw new Error(`API key not found: ${keyId}`);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = `${target}.bak.${stamp}`;
  fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
  if (key.isActive === isActive) return { changed: false, backupPath, dbPath: target, isActive };
  key.isActive = isActive;
  key.updatedAt = now.toISOString();
  const next = JSON.stringify(parsed, null, 2) + '\n';
  JSON.parse(next);
  const tmp = path.join(path.dirname(target), `.db.json.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, target);
  JSON.parse(fs.readFileSync(target, 'utf8'));
  return { changed: true, backupPath, dbPath: target, isActive };
}

export function atomicDisableApiKey(keyId: string, baseDir?: string, now = new Date()): ToggleResult {
  return atomicToggleApiKey(keyId, false, baseDir, now);
}

export function atomicEnableApiKey(keyId: string, baseDir?: string, now = new Date()): ToggleResult {
  return atomicToggleApiKey(keyId, true, baseDir, now);
}
