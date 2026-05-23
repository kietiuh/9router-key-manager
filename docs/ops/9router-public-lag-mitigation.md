# 9router Public Lag Mitigation

This runbook keeps the GoCinema public-site lag mitigation repeatable after a VPS rebuild or 9router reinstall.

## Ownership

- The runtime setting lives in the 9router SQLite DB, normally `~/.9router/db/data.sqlite`.
- The automation lives in this `9router-key-manager` repo because it is the GoCinema-controlled deployment repo.
- This repo does not patch compiled 9router files. Keep 9router update-friendly unless an emergency explicitly requires a temporary local patch.

## Why This Exists

The public site can lag when large `/v1/*` requests share the same 9router Next/Node process that serves public UI and static assets. The worst low-risk contributor observed on 2026-05-23 was `requestDetails` observability data storing large request/response payloads with JSON serialization and synchronous SQLite writes.

The first mitigation is to disable detailed 9router observability payload capture while preserving usage/accounting data in `usageHistory`.

Target settings:

```json
{
  "enableObservability": false,
  "observabilityMaxRecords": 100,
  "observabilityMaxJsonSize": 5
}
```

Some older DBs may also contain `observabilityEnabled`. Current 9router runtime and UI read `enableObservability`, so this runbook sets `enableObservability=false`. When the legacy `observabilityEnabled` key already exists, the script also sets it to `false` so older installs and rollback checks do not accidentally re-enable detailed payload capture.

Do not start by limiting request body size or sharply reducing model concurrency. Those changes can degrade large client requests that currently work.

## Fresh VPS Setup

After installing and starting 9router and `9router-key-manager`, apply this runbook before opening traffic broadly.

1. Confirm 9router is installed and has initialized its DB:

```bash
node -p "require('/usr/lib/node_modules/9router/package.json').version"
test -f /root/.9router/db/data.sqlite
```

2. Confirm the latest npm version before deciding whether to upgrade:

```bash
npm view 9router version
```

3. Dry-run the mitigation:

```bash
cd /root/.openclaw/workspace/code/github/9router-key-manager
npm run ops:mitigate-9router-observability
```

4. Apply the mitigation:

```bash
npm run ops:mitigate-9router-observability -- --apply
```

The script creates an online SQLite backup before writing. It prints the backup path and the previous/current target settings.
The script output intentionally includes only observability settings, not full raw 9router settings.

5. Wait 10-15 seconds for 9router's cached settings to refresh, then verify:

```bash
curl -sS -o /tmp/gocinema-root -w "code=%{http_code} start=%{time_starttransfer} total=%{time_total} size=%{size_download}\n" --max-time 20 http://127.0.0.1:20128/
curl -sS -o /tmp/gocinema-auth -w "code=%{http_code} start=%{time_starttransfer} total=%{time_total} size=%{size_download}\n" --max-time 20 http://127.0.0.1:20128/api/auth/status
curl -k -sS -o /tmp/gocinema-public -w "code=%{http_code} start=%{time_starttransfer} total=%{time_total} size=%{size_download}\n" --max-time 20 https://gocinema.io.vn/
curl -k -sS -o /tmp/gocinema-admin -w "code=%{http_code} start=%{time_starttransfer} total=%{time_total} size=%{size_download}\n" --max-time 20 https://admin.gocinema.io.vn/
```

6. Check for new upstream errors:

```bash
journalctl -u caddy.service --since '10 minutes ago' -g '502|connection reset|connection refused|context deadline|read: connection reset' -o short-iso
journalctl -u 9router.service --since '10 minutes ago' -o short-iso
```

## Production Rollout

Use this order for an already-running server:

1. Confirm production clients and decide whether a maintenance window is required.
2. Capture baseline latency for direct 9router, public domain, and admin domain.
3. Run the script in dry-run mode and keep the printed `current` settings for rollback.
4. Run the script with `--apply`.
5. Do not restart 9router unless the setting does not take effect after 10-15 seconds.
6. Verify latency, Caddy logs, 9router logs, and admin key viewing/saving.

## Rollback

Preferred rollback uses the `current` settings printed by the dry-run/apply output:

```bash
npm run ops:mitigate-9router-observability -- \
  --apply \
  --enable-observability \
  --max-records 1000 \
  --max-json-kb 1024
```

If the previous values were different, use those values instead. The script backs up before rollback writes as well.

Emergency full DB restore should only happen in a maintenance window:

```bash
systemctl stop 9router.service
cp /root/.9router/db/backups/<backup-file>.bak /root/.9router/db/data.sqlite
systemctl start 9router.service
```

Prefer settings rollback over full DB restore because full restore can discard usage rows created after the backup.

## Upgrade Check

Before upgrading 9router:

1. Check current and latest versions:

```bash
node -p "require('/usr/lib/node_modules/9router/package.json').version"
npm view 9router version
```

2. Review release notes and changed files for the version range.
3. Confirm the observability settings still exist or update this runbook and script first.

The 9router `0.4.59` runtime was checked on 2026-05-23. Its request-details repository reads:

- `enableObservability` from SQLite settings.
- `OBSERVABILITY_ENABLED=false` only as an environment fallback when the SQLite key is absent.
- `observabilityMaxRecords`, `observabilityBatchSize`, `observabilityFlushIntervalMs`, and `observabilityMaxJsonSize`.

After future 9router upgrades, re-check the installed runtime before applying assumptions:

```bash
rg -a "enableObservability|OBSERVABILITY_ENABLED|observabilityMaxJsonSize|requestDetails" /usr/lib/node_modules/9router/app/.next-cli-build/server
```

4. Back up `/root/.9router/db/data.sqlite`.
5. Upgrade 9router in a maintenance window.
6. Re-run this script in dry-run mode, then apply if the target settings are missing or reverted.

## Documentation Update Rule

Any change that affects GoCinema production setup must update this document in the same commit. This includes:

- Caddy route changes for `gocinema.io.vn`, `admin.gocinema.io.vn`, or `user.gocinema.io.vn`.
- 9router install, upgrade, DB path, or systemd changes.
- Key-manager deploy path, service name, port, or environment variable changes.
- Observability, usage, quota, large-context, or concurrency settings.
- Any rollback or verification command that changes in practice.

Do not push operational changes without updating this runbook when one of the items above changes.
