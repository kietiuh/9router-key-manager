#!/usr/bin/env tsx
// Inspect usage_events distribution per api_key to find hot keys.
// Dry-run only — does not modify the DB.

import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const KEY = process.argv[2];
const DB_PATH = process.env.KEY_MANAGER_DB ?? path.join(os.homedir(), '.local/state/9router-key-manager/manager.sqlite');

const db = new Database(DB_PATH, { readonly: true });

try {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n;
  console.log(`Total usage_events rows: ${total}`);

  const top = db.prepare(`
    SELECT api_key, COUNT(*) AS n,
           MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
    FROM usage_events
    GROUP BY api_key
    ORDER BY n DESC
    LIMIT 10
  `).all() as Array<{ api_key: string | null; n: number; first_ts: string; last_ts: string }>;
  console.log('\nTop 10 keys by row count:');
  for (const r of top) {
    console.log(`  ${r.api_key ?? '<null>'.padEnd(46)}  rows=${String(r.n).padStart(8)}  range=${r.first_ts} → ${r.last_ts}`);
  }

  if (KEY) {
    const exact = db.prepare(`
      SELECT COUNT(*) AS n,
             MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
      FROM usage_events
      WHERE api_key = ? OR api_key LIKE ?
    `).get(KEY, `${KEY}%`) as { n: number; first_ts: string; last_ts: string };
    console.log(`\nKey ${KEY} row count: ${exact.n}  range=${exact.first_ts} → ${exact.last_ts}`);

    // Match against raw_json in case the canonical api_key was rewritten
    const matchLike = db.prepare(`
      SELECT COUNT(*) AS n
      FROM usage_events
      WHERE raw_json LIKE ?
    `).get(`%${KEY}%`) as { n: number };
    console.log(`Rows whose raw_json contains the key: ${matchLike.n}`);

    const rawJsonSizes = db.prepare(`
      SELECT id, LENGTH(raw_json) AS sz FROM usage_events
      WHERE api_key = ? OR api_key LIKE ?
      ORDER BY sz DESC LIMIT 5
    `).all(KEY, `${KEY}%`) as Array<{ id: number; sz: number }>;
    if (rawJsonSizes.length) {
      console.log('Largest raw_json sizes for this key:');
      for (const r of rawJsonSizes) console.log(`  id=${r.id}  raw_json=${r.sz} bytes`);
    }
  }
} finally {
  db.close();
}
