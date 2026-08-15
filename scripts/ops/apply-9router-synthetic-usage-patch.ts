#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { default9routerDbPath } from '../../src/server/ops/9routerObservability.js';
import {
  PATCH_MARKER,
  REQUEST_DETAILS_PATCH_MARKER,
  REQUEST_DETAILS_TOKEN_PATCH_MARKER,
  patch9routerUsageBundle,
  readSyntheticUsageProviderIds,
  type ProviderNodeRow,
} from '../../src/server/ops/9routerSyntheticUsagePatch.js';

const DEFAULT_BUNDLE_PATH = '/usr/lib/node_modules/9router/app/.next-cli-build/server/chunks/6379.js';

interface CliOptions {
  apply: boolean;
  bundlePath: string;
  dbPath: string;
  providerIds: string[];
}

function usage() {
  return `Patch installed 9router to synthesize token usage for v4/cl zero-token usage rows
and keep streaming requestDetails rows aligned with completed stream usage.

Default mode is dry-run. Use --apply to write the installed 9router bundle.

Options:
  --apply              Write the patched bundle.
  --bundle <path>      9router server chunk path. Default: ${DEFAULT_BUNDLE_PATH}
  --db <path>          9router SQLite DB path. Defaults to NINE_ROUTER_DB,
                       NINE_ROUTER_DIR/db/data.sqlite, or ~/.9router/db/data.sqlite.
  --provider-id <id>   Additional provider node id to patch. Can be repeated.
  --help               Show this help.

Behavior:
  For providerNodes with prefix "v4" or "cl", if input tokens are 0, 9router
  records a random 50,000-100,000 input tokens. If output tokens are 0, it
  records a random 100-5,000 output tokens. Existing nonzero usage is preserved.
  Streaming requestDetails use the same row id from stream start through stream
  completion, so Recent Requests is updated instead of being crowded by 0/0
  in-progress rows.

Examples:
  npm run ops:patch-9router-synthetic-usage
  npm run ops:patch-9router-synthetic-usage -- --apply

Note: This script no longer creates automatic bundle backups. Make a copy of the
bundle manually before invoking --apply if you need rollback.
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
    bundlePath: DEFAULT_BUNDLE_PATH,
    dbPath: default9routerDbPath(),
    providerIds: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--bundle') {
      options.bundlePath = readValue(argv, i, '--bundle');
      i += 1;
    } else if (arg.startsWith('--bundle=')) {
      options.bundlePath = arg.slice('--bundle='.length);
    } else if (arg === '--db') {
      options.dbPath = readValue(argv, i, '--db');
      i += 1;
    } else if (arg.startsWith('--db=')) {
      options.dbPath = arg.slice('--db='.length);
    } else if (arg === '--provider-id') {
      options.providerIds.push(readValue(argv, i, '--provider-id'));
      i += 1;
    } else if (arg.startsWith('--provider-id=')) {
      options.providerIds.push(arg.slice('--provider-id='.length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readProviderIdsFromDb(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT id, data FROM providerNodes').all() as ProviderNodeRow[];
    return readSyntheticUsageProviderIds(rows);
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundlePath = path.resolve(options.bundlePath);
  if (!fs.existsSync(bundlePath)) throw new Error(`9router bundle not found: ${bundlePath}`);

  const providerIds = [...new Set([...readProviderIdsFromDb(options.dbPath), ...options.providerIds])].sort();
  const current = fs.readFileSync(bundlePath, 'utf8');
  const result = patch9routerUsageBundle(current, { providerIds });

  if (options.apply && result.changed) {
    fs.writeFileSync(bundlePath, result.content);
  }

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    bundlePath,
    dbPath: options.dbPath,
    providerIds,
    markers: {
      syntheticUsage: PATCH_MARKER,
      streamingRequestDetails: REQUEST_DETAILS_PATCH_MARKER,
      streamingRequestDetailsTokens: REQUEST_DETAILS_TOKEN_PATCH_MARKER,
    },
    changed: result.changed,
    note: options.apply
      ? 'Patch written if changed. Restart 9router before verifying new usage rows.'
      : 'Dry-run only. Re-run with --apply to write the installed 9router bundle.',
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
