# Bot Migration — Environment Variable Summary

> Generated: 2026-08-03
> Source of truth verified against the **live running process**
> (`/proc/<pid>/environ` for `gocinema-assistant-bot.service`)
> and `/etc/9router-key-manager.env`.

This document is the checklist for moving the **GoCinema Assistant Telegram bot**
from the current host to a new server. The bot process (`src/bot/index.ts`,
started by `npm run start:bot`) reads its config via `src/bot/config.ts`.

---

## 1. Production env file location (current host)

```
/etc/9router-key-manager.env   # loaded by systemd via EnvironmentFile=
```

This file is the **single source of truth** in production. The local `.env`
in the repo is only a partial mirror used for dev parity (it contains the
8 bot-specific variables and is gitignored).

Systemd unit:
```
/etc/systemd/system/gocinema-assistant-bot.service
```

---

## 2. Variables the BOT actually reads

Verified by grepping `process.env` in `src/bot/`:

| # | Variable | Required? | Purpose | Default in code |
|---|----------|-----------|---------|-----------------|
| 1 | `TELEGRAM_BOT_TOKEN` | **YES** (throws if missing) | BotFather token for `@gocinema_assistant_bot` | — |
| 2 | `BOT_PUBLIC_API_BASE_URL` | no | Base URL of this service's public key-check API (used by `/refresh`) | `http://127.0.0.1:3000` |
| 3 | `BOT_POLL_TIMEOUT_SECONDS` | no | Long-poll timeout for `getUpdates` | `30` |
| 4 | `BOT_REQUEST_TIMEOUT_SECONDS` | no | HTTP timeout for the KeyManager public API (×1000 ms) | `15` |
| 5 | `BOT_ALERT_CHECK_INTERVAL_SECONDS` | no | Proactive-alert delivery queue scan interval | `300` |
| 6 | `BOT_ALERT_BATCH_LIMIT` | no | Max alerts drained per scan | `50` |
| 7 | `BOT_DEFAULT_ALERT_THRESHOLD_PERCENT` | no | Default subscriber alert threshold (%) | `10` |
| 8 | `BOT_TIMEZONE_OFFSET_HOURS` | no | Display TZ offset for AlertEngine + bot | `7` |

Only `TELEGRAM_BOT_TOKEN` is mandatory. The other 7 are operational
tunables with safe defaults baked into `src/bot/config.ts`.

---

## 3. Full env file on the current host (24 vars)

The bot systemd unit inherits **everything** in
`/etc/9router-key-manager.env`, even vars only the Fastify API server
needs. All 24 are listed below, grouped by who reads them.

### A. Bot-only (must be present on the new server)

| Variable | Current value | Notes |
|----------|---------------|-------|
| `TELEGRAM_BOT_TOKEN` | `8903974115:AAE…qrRM7s` | **SECRET** — copy verbatim from old host, never commit |
| `BOT_PUBLIC_API_BASE_URL` | `http://127.0.0.1:3000` | If new host uses a different port, update here |
| `BOT_POLL_TIMEOUT_SECONDS` | `30` | safe default |
| `BOT_REQUEST_TIMEOUT_SECONDS` | `15` | safe default |
| `BOT_ALERT_CHECK_INTERVAL_SECONDS` | `300` | safe default |
| `BOT_ALERT_BATCH_LIMIT` | `50` | safe default |
| `BOT_DEFAULT_ALERT_THRESHOLD_PERCENT` | `10` | safe default |
| `BOT_TIMEZONE_OFFSET_HOURS` | `7` | Vietnam time |

### B. API/server vars the bot process inherits (no direct use by bot code, but needed because the same env file is shared)

| Variable | Current value | Read by |
|----------|---------------|---------|
| `NODE_ENV` | `production` | API server (and convention for bot) |
| `HOST` | `127.0.0.1` | API server bind address |
| `PORT` | `3000` | API server port — **must match `BOT_PUBLIC_API_BASE_URL`** |
| `ADMIN_PASSWORD` | `levuphong` | **SECRET** — admin login password for the dashboard |
| `SESSION_SECRET` | `bd7060b7…6520` | **SECRET** — session signing (Fastify cookie) |
| `CORS_ORIGINS` | `https://admin-mana.gocinema.io.vn` | API CORS allowlist — update if new admin domain changes |
| `COOKIE_SECURE` | `true` | Required when serving behind HTTPS |
| `NINE_ROUTER_DIR` | `/home/ubuntu/.9router` | 9router runtime storage path |
| `KEY_MANAGER_DB` | `/home/ubuntu/.local/state/9router-key-manager/manager.sqlite` | Manager SQLite path — **must point to the same DB the watcher writes to** |
| `WEB_ROOT` | `/home/ubuntu/9router-key-manager/dist/web` | Static dashboard build output |
| `NINE_ROUTER_UPSTREAM` | `http://127.0.0.1:20128` | 9router API base URL the watcher talks to |
| `WATCH_INTERVAL_MS` | `60000` | Watcher scan interval |
| `HARD_DISABLE` | `true` | Enables hard-disable action on quota breach — keep `true` for parity |
| `API_KEY_CACHE_TTL_MS` | `5000` | API-key lookup cache TTL on `/v1` hot path |
| `TRAFFIC_UPSTREAM_TIMEOUTS` | `cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000` | Upstream deadline policy |
| `TRAFFIC_LARGE_CONTEXT_TOKENS` | `100000` | Threshold for switching to large-context deadlines |
| `TRAFFIC_LOG_LIMITER_SNAPSHOT` | `false` | Verbose limiter logging — keep `false` for production |

### C. Variables in the systemd example but NOT actually used by code

| Variable | Notes |
|----------|-------|
| `KEY_MANAGER_DB` (in unit) | Set by `deploy/systemd/gocinema-assistant-bot.service.example`, but `src/bot/` does **not** call `process.env.KEY_MANAGER_DB`. The bot reads the DB via `src/bot/database.ts`, which currently uses a hard-coded path (`~/.local/state/9router-key-manager/manager.sqlite`). If you want the bot to honor this on the new host, either ensure the hard-coded path matches, or refactor `database.ts` to read the env var. |

---

## 4. Files and paths to migrate (not env, but required for the bot to start)

On the new server, the bot will fail or behave wrong if these are missing:

| Path | Why | Notes |
|------|-----|-------|
| `/home/ubuntu/.9router/` (or `$NINE_ROUTER_DIR`) | 9router runtime data (db.json, usage.json, data.sqlite) | Required by the **API server**, not the bot directly — but the bot depends on the API |
| `/home/ubuntu/.local/state/9router-key-manager/manager.sqlite` | Manager SQLite (alerts, subscribers, key policies) | Bot's `database.ts` reads this. Copy the file from the old host; alerts and per-user settings live here |
| `/home/ubuntu/9router-key-manager/` | Repo working directory | Systemd unit sets `WorkingDirectory=` here |
| `/home/ubuntu/9router-key-manager/node_modules/` | Run `npm ci` on the new host |
| `/home/ubuntu/9router-key-manager/dist/web/` | Built dashboard (only if you also run the API from this repo) | Not needed by the bot itself |

The bot's **persistent state** lives entirely in `manager.sqlite`. Subscribers,
thresholds, and the alert queue are all there — without that file copy, every
user will appear as a fresh subscriber.

---

## 5. Migration checklist

1. **Copy `manager.sqlite`** from old host to new host, preserving path or updating `KEY_MANAGER_DB` in the new env file.
2. **Choose a deploy strategy** for the env file:
   - **Option A (recommended):** write `/etc/9router-key-manager.env` on the new host using the values from section 3.
   - **Option B:** use a secret manager / 1Password CLI to materialize the file at boot.
3. **Create the systemd unit** from `deploy/systemd/gocinema-assistant-bot.service.example`. Update `WorkingDirectory=` and the bot unit's `ExecStart=` path. Confirm `EnvironmentFile=-/etc/9router-key-manager.env`.
4. **Verify env vars are loaded by the bot process** after start:
   ```bash
   PID=$(systemctl show -p MainPID gocinema-assistant-bot.service --value)
   sudo tr '\0' '\n' < /proc/$PID/environ | grep -E '^(TELEGRAM|BOT_)' | sort
   ```
   Expect 8 `BOT_*` lines plus `TELEGRAM_BOT_TOKEN`.
5. **Verify the bot can reach the API** (same host, port 3000):
   ```bash
   curl -s http://127.0.0.1:3000/api/health
   ```
6. **Smoke-test from Telegram:** send `/start` to `@gocinema_assistant_bot` and confirm the quota screen renders. This exercises `TELEGRAM_BOT_TOKEN` + `BOT_PUBLIC_API_BASE_URL` + `manager.sqlite` end-to-end.
7. **Confirm watcher parity** (only relevant if you also migrate the API server):
   - `NINE_ROUTER_DIR` must point to the same 9router data the bot's `/refresh` calls summarize.
   - `HARD_DISABLE=true` if you want quota-breach disable to keep working.

---

## 6. Sensitive values — handle with care

The following 3 values are secrets. Do **not** commit them, do **not** paste
them into chat logs, and transfer them via a secure channel (SSH/scp,
password manager, sealed env):

- `TELEGRAM_BOT_TOKEN` — BotFather token. Rotating it requires updating
  Telegram webhook/long-poll registration.
- `ADMIN_PASSWORD` — admin login password for the dashboard.
- `SESSION_SECRET` — session-signing key. Rotating it invalidates all
  existing admin sessions but is otherwise safe.

---

## 7. Quick reference — minimum env for the bot to start

If you only want to bring up the bot in isolation (no API server co-located),
the **strict minimum** is:

```bash
TELEGRAM_BOT_TOKEN=<from BotFather>
BOT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000   # or wherever the API lives
KEY_MANAGER_DB=/home/ubuntu/.local/state/9router-key-manager/manager.sqlite
```

Plus the 5 other `BOT_*` tunables if you want to override the defaults.
Everything else in `/etc/9router-key-manager.env` is for the Fastify API
server, which the bot talks to but does not start.
