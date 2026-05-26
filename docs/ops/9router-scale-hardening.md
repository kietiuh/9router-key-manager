# 9router Scale Hardening

This runbook keeps the current single-VPS GoCinema deployment scalable without moving off SQLite before it is necessary.

## Current Architecture

- Caddy is the public entry point on ports 80 and 443.
- `gocinema.io.vn /v1/*` routes to `9router-key-manager` on `127.0.0.1:3000`.
- `9router-key-manager` applies key expiry/quota checks, model rewrite, traffic limiting, and failover, then proxies to 9router on `127.0.0.1:20128`.
- 9router stores upstream key/runtime state in `/root/.9router/db/data.sqlite`.
- Key-manager stores policy, alert, and imported usage state in `/root/.local/state/9router-key-manager/manager.sqlite`.

## Runtime Hardening

Keep backend ports private. The services should listen locally and Caddy should be the only public path.

```ini
# /etc/systemd/system/9router-key-manager.service.d/scale-hardening.conf
[Service]
Environment=HOST=127.0.0.1
Environment=API_KEY_CACHE_TTL_MS=5000
Environment=TRAFFIC_LOG_LIMITER_SNAPSHOT=false
```

```ini
# /etc/systemd/system/9router.service.d/listen-local.conf
[Service]
Environment=HOSTNAME=127.0.0.1
```

After writing drop-ins:

```bash
systemctl daemon-reload
systemctl restart 9router.service
systemctl restart 9router-key-manager.service
ss -ltnp | grep -E ':(3000|20128)\b'
```

Expected: ports `3000` and `20128` bind to `127.0.0.1`, not `0.0.0.0`.

## Journald Retention

Successful proxy logs are compact by default. Keep host journal storage bounded too:

```ini
# /etc/systemd/journald.conf.d/9router-retention.conf
[Journal]
SystemMaxUse=500M
RuntimeMaxUse=100M
MaxRetentionSec=7day
```

Apply and compact existing journal files:

```bash
systemctl restart systemd-journald
journalctl --vacuum-size=500M
journalctl --disk-usage
```

## Storage Maintenance

Dry-run first:

```bash
cd /root/.openclaw/workspace/code/github/9router-key-manager
npm run ops:maintain-key-manager-storage
```

Apply during a short maintenance window after stopping writers:

```bash
systemctl stop gocinema-assistant-bot.service
systemctl stop 9router-key-manager.service
npm run ops:maintain-key-manager-storage -- --apply
systemctl start 9router-key-manager.service
systemctl start gocinema-assistant-bot.service
```

The command backs up `manager.sqlite` before writes, deduplicates logical `usage_events`, rewrites surviving signatures to the canonical no-cost form, clears expired public image file references, deletes expired image files when present, and runs `VACUUM` unless `--no-vacuum` is passed.

## Verification

After rollout:

```bash
systemctl show 9router.service --property=ActiveState,SubState,NRestarts,ExecMainStatus,Result,MainPID
systemctl show 9router-key-manager.service --property=ActiveState,SubState,NRestarts,ExecMainStatus,Result,MainPID
curl -sS http://127.0.0.1:3000/api/health
curl -k -sS -o /tmp/gocinema-check -w "code=%{http_code} total=%{time_total}\n" https://user.gocinema.io.vn/check
curl -k -sS -o /tmp/gocinema-models -w "code=%{http_code} total=%{time_total}\n" https://gocinema.io.vn/v1/models
```

Recent healthy key-manager proxy logs should include `queuedMs`, `upstreamMs`, `upstreamTimeoutMs`, and no large `limiter` array unless `TRAFFIC_LOG_LIMITER_SNAPSHOT=true`.

## When To Move Beyond SQLite

Do not move to Postgres/Redis just because SQLite files are visible. Consider a larger redesign only when one of these becomes true:

- multiple key-manager instances must share quota state;
- usage import or summary queries become a measurable latency source;
- write volume makes `manager.sqlite` maintenance disruptive;
- queue/concurrency state must be shared across VPS instances.

Until then, the lighter path is to keep SQLite, compact logs, cache hot-path key lookups, and run storage maintenance periodically.
