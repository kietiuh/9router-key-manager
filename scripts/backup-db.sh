#!/usr/bin/env bash
# Create a single, fixed-name backup of the 9router-key-manager SQLite DB.
# Each run overwrites the previous backup. Run manually when you need rollback.
#
# Usage:
#   scripts/backup-db.sh                    # backup manager.sqlite
#   scripts/backup-db.sh /path/to/db.sqlite # backup the given DB
#
# Backup path: <db-dir>/manager.sqlite.bak
#
# Requires: sqlite3 CLI (uses online .backup for an atomic snapshot).

set -euo pipefail

DB_PATH="${1:-${KEY_MANAGER_DB:-$HOME/.local/state/9router-key-manager/manager.sqlite}}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "error: DB not found: $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "error: sqlite3 CLI is required (apt install sqlite3)" >&2
  exit 1
fi

DB_DIR="$(dirname "$DB_PATH")"
BACKUP_PATH="${DB_DIR}/manager.sqlite.bak"

# Online backup: acquires a shared lock and writes a clean snapshot even while
# the running service keeps the WAL active.
sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"

# Verify the backup is readable.
sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;"

SIZE_BYTES="$(stat -c%s "$BACKUP_PATH")"
SIZE_HUMAN="$(du -h "$BACKUP_PATH" | cut -f1)"

echo "Backup written: $BACKUP_PATH ($SIZE_HUMAN, $SIZE_BYTES bytes)"
