#!/usr/bin/env tsx
// Clean usage_events rows for a specific api_key.
// Default mode is dry-run. Use --apply to write changes.
//
// Strategy: keep the last N rows (newest by id), delete the rest.
// Optional: also delete rows older than --older-than-days N.
// Always makes a backup of the DB before --apply.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Args = {
  apply: boolean;
  key: string;
  keepLast: number;
  olderThanDays: number | null;
  dbPath: string;
  vacuum: boolean;
};

function usage() {
  return `Clean usage_events rows for a specific api_key.

Default mode is dry-run. Use --apply to write changes.

Required:
  --key <apiKey>      The api_key to clean (full string, prefix match supported).

Options:
  --apply                       Write changes.
  --keep-last <N>               Keep the newest N rows for the key before deleting the rest. Default: 0 (delete all).
  --older-than-days <N>         Only delete rows with timestamp older than N days. Default: no time filter.
  --db <path>                   Manager SQLite DB path. Default: KEY_MANAGER_DB or ~/.local/state/9router-key-manager/manager.sqlite.
  --no-vacuum                   Skip VACUUM after apply.
  --help                        Show this help.

Examples:
  # Dry-run: show how many rows would be deleted
  npx tsx scripts/ops/clean-key-usage.ts --key sk-df0b...-8438a2e1

  # Keep the last 5000 rows and delete older ones
  npx tsx scripts/ops/clean-key-usage.ts --key sk-df0b...-8438a2e1 --keep-last 5000 --apply

  # Delete only rows older than 14 days
  npx tsx scripts/ops/clean-key-usage.ts --key sk-df0b...-8438a2e1 --older-than-days 14 --apply

Note: This script no longer creates automatic backups. Run
scripts/backup-db.sh manually before invoking --apply if you need rollback.
`;
}

const argv = process.argv.slice(2);
function readValue(i: number, name: string): string {
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} requires a value`);
  return v;
}

function parseArgs(): Args {
  const defaults = {
    apply: false,
    key: '',
    keepLast: 0,
    olderThanDays: null as number | null,
    dbPath: process.env.KEY_MANAGER_DB ?? path.join(os.homedir(), '.local/state/9router-key-manager/manager.sqlite'),
    vacuum: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (a === '--apply') defaults.apply = true;
    else if (a === '--no-vacuum') defaults.vacuum = false;
    else if (a === '--key') { defaults.key = readValue(i, '--key'); i += 1; }
    else if (a === '--keep-last') { defaults.keepLast = Number(readValue(i, '--keep-last')); i += 1; }
    else if (a === '--older-than-days') { defaults.olderThanDays = Number(readValue(i, '--older-than-days')); i += 1; }
    else if (a === '--db') { defaults.dbPath = readValue(i, '--db'); i += 1; }
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!defaults.key) throw new Error('--key is required');
  if (!Number.isFinite(defaults.keepLast) || defaults.keepLast < 0) throw new Error('--keep-last must be >= 0');
  if (defaults.olderThanDays !== null && (!Number.isFinite(defaults.olderThanDays) || defaults.olderThanDays <= 0)) throw new Error('--older-than-days must be > 0');
  return defaults;
}

async function main() {
  const opts = parseArgs();
  const dbPath = path.resolve(opts.dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`manager SQLite DB not found: ${dbPath}`);

  const db = new Database(dbPath);
  let vacuumed = false;

  try {
    // Match either exact key or prefix (in case the key has a trailing suffix).
    const matchClause = `api_key = ? OR api_key LIKE ?`;
    const matchArgs = [opts.key, `${opts.key}%`];

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ${matchClause}`).get(...matchArgs) as { n: number }).n;

    // Build the "rows to keep" set when --keep-last is set
    let keepIds: Set<number> | null = null;
    if (opts.keepLast > 0) {
      const rows = db.prepare(`
        SELECT id FROM usage_events WHERE ${matchClause} ORDER BY id DESC LIMIT ?
      `).all(...matchArgs, opts.keepLast) as Array<{ id: number }>;
      keepIds = new Set(rows.map(r => r.id));
    }

    // Build the WHERE clause for what to delete
    const conds: string[] = [matchClause];
    const deleteArgs: any[] = [...matchArgs];
    if (opts.olderThanDays !== null) {
      const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      conds.push('timestamp < ?');
      deleteArgs.push(cutoff);
    }
    if (keepIds && keepIds.size > 0) {
      const placeholders = Array.from(keepIds).map(() => '?').join(',');
      conds.push(`id NOT IN (${placeholders})`);
      deleteArgs.push(...keepIds);
    }

    const toDelete = (db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ${conds.join(' AND ')}`).get(...deleteArgs) as { n: number }).n;

    console.log(JSON.stringify({
      mode: opts.apply ? 'apply' : 'dry-run',
      dbPath,
      key: opts.key,
      keepLast: opts.keepLast,
      olderThanDays: opts.olderThanDays,
      totalMatchingRows: total,
      rowsToDelete: toDelete,
      rowsToKeep: total - toDelete,
    }, null, 2));

    if (!opts.apply) {
      console.log('Dry-run only. Re-run with --apply to write changes.');
      return;
    }

    const deleted = db.transaction(() => {
      const res = db.prepare(`DELETE FROM usage_events WHERE ${conds.join(' AND ')}`).run(...deleteArgs);
      return Number(res.changes || 0);
    })();

    if (opts.vacuum) {
      db.exec('VACUUM');
      vacuumed = true;
    }

    console.log(JSON.stringify({ deleted, vacuumed }, null, 2));
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
