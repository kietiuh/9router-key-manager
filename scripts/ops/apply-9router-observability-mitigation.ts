#!/usr/bin/env tsx
import {
  DEFAULT_OBSERVABILITY_MITIGATION,
  applyObservabilityMitigation,
  default9routerDbPath,
} from '../../src/server/ops/9routerObservability.js';

interface CliOptions {
  apply: boolean;
  dbPath: string;
  backupDir?: string;
  createBackup: boolean;
  enableObservability: boolean;
  maxRecords: number;
  maxJsonKb: number;
}

function usage() {
  return `Apply the GoCinema public-lag 9router observability mitigation.

Default mode is dry-run. Use --apply to write settings.

Options:
  --apply                 Write settings to the 9router SQLite DB.
  --db <path>             9router SQLite DB path. Defaults to NINE_ROUTER_DB,
                          NINE_ROUTER_DIR/db/data.sqlite, or ~/.9router/db/data.sqlite.
  --backup-dir <path>     Directory for online SQLite backups before writes.
  --no-backup             Skip backup. Not recommended for production.
  --enable-observability  Set enableObservability=true. Useful for rollback.
  --disable-observability Set enableObservability=false. This is the default mitigation.
  --max-records <number>  requestDetails retention after mitigation. Default: 100.
  --max-json-kb <number>  per-section requestDetails JSON preview size in KB. Default: 5.
  --help                  Show this help.

Examples:
  npm run ops:mitigate-9router-observability
  npm run ops:mitigate-9router-observability -- --apply
  npm run ops:mitigate-9router-observability -- --apply --db /root/.9router/db/data.sqlite
`;
}

function readValue(argv: string[], index: number, name: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function readNumber(argv: string[], index: number, name: string) {
  const value = Number(readValue(argv, index, name));
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    dbPath: default9routerDbPath(),
    createBackup: true,
    enableObservability: DEFAULT_OBSERVABILITY_MITIGATION.enableObservability,
    maxRecords: DEFAULT_OBSERVABILITY_MITIGATION.observabilityMaxRecords,
    maxJsonKb: DEFAULT_OBSERVABILITY_MITIGATION.observabilityMaxJsonSize,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--no-backup') {
      options.createBackup = false;
    } else if (arg === '--enable-observability') {
      options.enableObservability = true;
    } else if (arg === '--disable-observability') {
      options.enableObservability = false;
    } else if (arg === '--db') {
      options.dbPath = readValue(argv, i, '--db');
      i += 1;
    } else if (arg.startsWith('--db=')) {
      options.dbPath = arg.slice('--db='.length);
    } else if (arg === '--backup-dir') {
      options.backupDir = readValue(argv, i, '--backup-dir');
      i += 1;
    } else if (arg.startsWith('--backup-dir=')) {
      options.backupDir = arg.slice('--backup-dir='.length);
    } else if (arg === '--max-records') {
      options.maxRecords = readNumber(argv, i, '--max-records');
      i += 1;
    } else if (arg.startsWith('--max-records=')) {
      options.maxRecords = Number(arg.slice('--max-records='.length));
    } else if (arg === '--max-json-kb') {
      options.maxJsonKb = readNumber(argv, i, '--max-json-kb');
      i += 1;
    } else if (arg.startsWith('--max-json-kb=')) {
      options.maxJsonKb = Number(arg.slice('--max-json-kb='.length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.maxRecords) || options.maxRecords < 0) {
    throw new Error('--max-records requires a non-negative integer');
  }
  if (!Number.isInteger(options.maxJsonKb) || options.maxJsonKb < 0) {
    throw new Error('--max-json-kb requires a non-negative integer');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await applyObservabilityMitigation({
    dbPath: options.dbPath,
    backupDir: options.backupDir,
    dryRun: !options.apply,
    createBackup: options.createBackup,
    desired: {
      enableObservability: options.enableObservability,
      observabilityMaxRecords: options.maxRecords,
      observabilityMaxJsonSize: options.maxJsonKb,
    },
  });

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    dbPath: result.dbPath,
    changed: result.changed,
    backupPath: result.backupPath,
    current: selectObservabilitySettings(result.current),
    target: selectObservabilitySettings(result.target),
    note: options.apply
      ? 'Settings written. Wait 10-15 seconds for 9router cached settings to refresh before probing latency.'
      : 'Dry-run only. Re-run with --apply to write settings.',
  }, null, 2));
}

function selectObservabilitySettings(settings: Record<string, unknown>) {
  return {
    enableObservability: settings.enableObservability,
    observabilityEnabled: settings.observabilityEnabled,
    observabilityMaxRecords: settings.observabilityMaxRecords,
    observabilityBatchSize: settings.observabilityBatchSize,
    observabilityFlushIntervalMs: settings.observabilityFlushIntervalMs,
    observabilityMaxJsonSize: settings.observabilityMaxJsonSize,
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
