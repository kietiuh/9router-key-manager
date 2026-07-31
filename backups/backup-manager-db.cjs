#!/usr/bin/env node
// Safe, consistent snapshot of the manager SQLite DB.
// Uses better-sqlite3's .backup() which acquires a shared lock and
// writes a clean snapshot even while the running service keeps the WAL active.
//
// Usage: node backups/backup-manager-db.cjs [output-path]
//   Default output path: backups/manager-<ISO-timestamp>.sqlite

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SRC = process.env.KEY_MANAGER_DB
  || path.join(process.env.HOME || '/home/ubuntu', '.local/state/9router-key-manager/manager.sqlite');

const OUT = process.argv[2]
  || path.join(__dirname, `manager-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);

if (!fs.existsSync(SRC)) {
  console.error(`Source DB not found: ${SRC}`);
  process.exit(1);
}

const startedAt = Date.now();
console.log(`Source : ${SRC}`);
console.log(`Output : ${OUT}`);

(async () => {
  const db = new Database(SRC, { readonly: true, fileMustExist: true });
  try {
    await db.backup(OUT);
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
    process.exit(2);
  } finally {
    db.close();
  }

  const { size: outSize } = fs.statSync(OUT);
  const { size: srcSize } = fs.statSync(SRC);
  const ms = Date.now() - startedAt;

  console.log(`Done in ${ms}ms`);
  console.log(`Source size : ${(srcSize / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`Output size : ${(outSize / 1024 / 1024).toFixed(2)} MiB`);

  const verify = new Database(OUT, { readonly: true, fileMustExist: true });
  try {
    const row = verify.prepare('PRAGMA integrity_check').get();
    if (row && row.integrity_check === 'ok') {
      console.log('integrity_check: ok');
    } else {
      console.error('integrity_check FAILED:', row);
      process.exit(3);
    }
  } finally {
    verify.close();
  }
})();
