import os from 'node:os';
import path from 'node:path';

export function default9routerDir(): string {
  return process.env.NINE_ROUTER_DIR ?? path.join(os.homedir(), '.9router');
}

export function dbJsonPath(baseDir = default9routerDir()): string {
  return path.join(baseDir, 'db.json');
}

export function usageJsonPath(baseDir = default9routerDir()): string {
  return path.join(baseDir, 'usage.json');
}

export function dataSqlitePath(baseDir = default9routerDir()): string {
  return path.join(baseDir, 'db', 'data.sqlite');
}
