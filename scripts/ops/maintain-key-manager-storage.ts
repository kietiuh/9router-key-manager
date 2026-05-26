#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maintainKeyManagerStorage } from '../../src/server/ops/keyManagerStorageMaintenance.js';

type CliOptions = {
  apply: boolean;
  dbPath: string;
  publicImageDir?: string;
  backupDir?: string;
  createBackup: boolean;
  vacuum: boolean;
};

function defaultStateDir() {
  return process.env.KEY_MANAGER_STATE_DIR ?? path.join(os.homedir(), '.local/state/9router-key-manager');
}

function defaultDbPath() {
  return process.env.KEY_MANAGER_DB ?? path.join(defaultStateDir(), 'manager.sqlite');
}

function defaultPublicImageDir() {
  return process.env.PUBLIC_IMAGE_DIR ?? path.join(defaultStateDir(), 'public-images');
}

function usage() {
  return `Maintain 9router-key-manager SQLite storage.

Default mode is dry-run. Use --apply to write changes.

Options:
  --apply               Deduplicate usage rows, rewrite canonical signatures, and clear expired image files.
  --db <path>           Manager SQLite DB path. Defaults to KEY_MANAGER_DB or ~/.local/state/9router-key-manager/manager.sqlite.
  --public-image-dir    Public image directory. Defaults to PUBLIC_IMAGE_DIR or the manager state public-images directory.
  --backup-dir <path>   Directory for online SQLite backups before writes. Defaults beside the DB.
  --no-backup           Skip backup. Not recommended for production.
  --no-vacuum           Skip VACUUM after apply.
  --help                Show this help.

Examples:
  npm run ops:maintain-key-manager-storage
  npm run ops:maintain-key-manager-storage -- --apply
  npm run ops:maintain-key-manager-storage -- --apply --no-vacuum
`;
}

function readValue(argv: string[], index: number, name: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    dbPath: defaultDbPath(),
    publicImageDir: defaultPublicImageDir(),
    createBackup: true,
    vacuum: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--apply') options.apply = true;
    else if (arg === '--no-backup') options.createBackup = false;
    else if (arg === '--no-vacuum') options.vacuum = false;
    else if (arg === '--db') {
      options.dbPath = readValue(argv, i, '--db');
      i += 1;
    } else if (arg.startsWith('--db=')) {
      options.dbPath = arg.slice('--db='.length);
    } else if (arg === '--public-image-dir') {
      options.publicImageDir = readValue(argv, i, '--public-image-dir');
      i += 1;
    } else if (arg.startsWith('--public-image-dir=')) {
      options.publicImageDir = arg.slice('--public-image-dir='.length);
    } else if (arg === '--backup-dir') {
      options.backupDir = readValue(argv, i, '--backup-dir');
      i += 1;
    } else if (arg.startsWith('--backup-dir=')) {
      options.backupDir = arg.slice('--backup-dir='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function backupPathFor(dbPath: string, backupDir?: string) {
  const dir = backupDir ?? path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${path.basename(dbPath)}.maintenance.${stamp()}.bak`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(options.dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`manager SQLite DB not found: ${dbPath}`);

  const db = new Database(dbPath);
  let backupPath: string | null = null;
  let vacuumed = false;
  try {
    if (options.apply && options.createBackup) {
      backupPath = backupPathFor(dbPath, options.backupDir);
      await db.backup(backupPath);
    }
    const summary = maintainKeyManagerStorage(db, {
      apply: options.apply,
      publicImageDir: options.publicImageDir,
    });
    if (options.apply && options.vacuum) {
      db.exec('VACUUM');
      vacuumed = true;
    }
    console.log(JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      dbPath,
      publicImageDir: options.publicImageDir,
      backupPath,
      vacuumed,
      summary,
      note: options.apply ? 'Storage maintenance applied.' : 'Dry-run only. Re-run with --apply to write changes.',
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
