# Bot Migration Runbook — Full Self-Contained Guide

> ⚠️ **DO NOT COMMIT THIS FILE TO GIT.** It contains live secrets
> (`TELEGRAM_BOT_TOKEN`, `ADMIN_PASSWORD`, `SESSION_SECRET`).
> Add it to `.gitignore` locally or keep it outside the repo.
>
> Generated: 2026-08-03 from the live host
> (`/etc/9router-key-manager.env` + `/proc/<pid>/environ`).
>
> Goal: move the **GoCinema Assistant Telegram bot** (and the
> **9router Key Manager API** that it depends on) from the current
> Ubuntu server to a new server, with zero changes to Telegram-side
> configuration and zero loss of bot subscribers / alert state.

---

## 0. TL;DR — what runs where

```
┌──────────────────────────────────────────────────────────────┐
│ New Ubuntu server (same OS family as old: 22.04/24.04)       │
│                                                              │
│   /etc/9router-key-manager.env        ← shared env file      │
│                                                              │
│   systemd: 9router-key-manager.service  ← API on :3000       │
│            └─ Requires= ─┐                                  │
│                          ▼                                  │
│   systemd: gocinema-assistant-bot.service  ← bot (long-poll)│
│                                                              │
│   /home/ubuntu/9router-key-manager/    ← repo               │
│   /home/ubuntu/.9router/               ← 9router runtime     │
│   /home/ubuntu/.local/state/9router-key-manager/             │
│       manager.sqlite                   ← persistent state    │
└──────────────────────────────────────────────────────────────┘
```

The bot is a long-polling Telegram client. It depends on the API
service for `/refresh`, quota history, and the alert queue.

---

## 1. Prerequisites on the new server

| Requirement | Value (matched to current host) |
|-------------|---------------------------------|
| OS | Ubuntu 22.04 or 24.04 (matches current) |
| User | `ubuntu` (systemd units use `User=ubuntu`) |
| Node.js | **v24.18.0** (installed via nvm) |
| npm | **v11.16.0** (comes with Node 24) |
| Required ports | `3000` (API, bound to `127.0.0.1`) — only loopback; external traffic comes via the existing reverse proxy |
| Reverse proxy / domain | `https://admin-mana.gocinema.io.vn` already terminates TLS in front of port 3000 |
| 9router upstream | `127.0.0.1:20128` must also be reachable from this host (where 9router itself lives) |

### 1.1 Install Node + nvm

```bash
# as ubuntu user
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24.18.0
nvm use 24.18.0
nvm alias default 24.18.0
node --version   # v24.18.0
npm  --version   # 11.16.0
```

The systemd unit hard-codes the nvm bin path:
`/home/ubuntu/.nvm/versions/node/v24.18.0/bin`.
If you install Node elsewhere, adjust the unit's `Environment=PATH=`
and `ExecStart=` accordingly.

### 1.2 Install build deps for `better-sqlite3`

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3
```

`better-sqlite3` is a native module; without a C++ toolchain,
`npm ci` will fail at the postinstall step.

---

## 2. Files and state to migrate

### 2.1 What to copy

| Source (old host) | Destination (new host) | Size on disk (approx) | Why |
|---|---|---|---|
| `/home/ubuntu/9router-key-manager/` | `/home/ubuntu/9router-key-manager/` | ~50 MB (excl. node_modules) | Repo source — including `dist/web/`, `scripts/`, `deploy/` |
| `/home/ubuntu/.9router/` | `/home/ubuntu/.9router/` | varies | 9router runtime data (`db.json`, `usage.json`, `data.sqlite`). **Required by the API server, not the bot directly.** |
| `/home/ubuntu/.local/state/9router-key-manager/manager.sqlite` (+ `-shm`, `-wal`) | same path | ~280 MB on current host | Subscribers, alert queue, key policies, model whitelists |
| `/etc/9router-key-manager.env` | same path | <2 KB | Shared env file (see §3 for contents) |
| `/etc/systemd/system/9router-key-manager.service` | same path | <1 KB | API systemd unit |
| `/etc/systemd/system/gocinema-assistant-bot.service` | same path | <1 KB | Bot systemd unit |

### 2.2 Copy commands (run on the OLD host, then on the NEW host)

```bash
# --- ON OLD HOST ---
# 1. Snapshot the repo (skip node_modules; install fresh on new host)
rsync -a --exclude='node_modules' --exclude='.git' \
  /home/ubuntu/9router-key-manager/ \
  /tmp/migrate/9router-key-manager/

# 2. Snapshot 9router runtime data
rsync -a /home/ubuntu/.9router/ /tmp/migrate/dot-9router/

# 3. Snapshot manager SQLite (must copy all 3 files together)
mkdir -p /tmp/migrate/manager-db
cp -a /home/ubuntu/.local/state/9router-key-manager/* \
      /tmp/migrate/manager-db/

# 4. Snapshot systemd units and env file
sudo cp /etc/9router-key-manager.env          /tmp/migrate/
sudo cp /etc/systemd/system/9router-key-manager.service \
                                               /tmp/migrate/
sudo cp /etc/systemd/system/gocinema-assistant-bot.service \
                                               /tmp/migrate/

# 5. Tar everything for transfer
cd /tmp/migrate && tar czf /tmp/migrate.tar.gz .
ls -lh /tmp/migrate.tar.gz

# --- TRANSFER ---
scp /tmp/migrate.tar.gz ubuntu@<NEW_HOST>:/tmp/

# --- ON NEW HOST ---
sudo tar xzf /tmp/migrate.tar.gz -C /
# (or extract somewhere and copy piece by piece — see §4)
```

**Why SQLite needs all 3 files:**
`better-sqlite3` uses WAL mode. `manager.sqlite-wal` may contain
uncommitted-but-durable changes. If you copy only `manager.sqlite`,
you lose the last few seconds of writes and risk corruption. Always
stop the API service on the old host **first**, then copy all three.

---

## 3. Environment file — exact contents to drop into the new server

Path: `/etc/9router-key-manager.env`
Permissions: `0640 root:root` (systemd-readable by `User=ubuntu`).

> ⚠️ The values below are **live production secrets** copied directly
> from the running host. Treat the file as a secret.

```dotenv
# --- Runtime mode ---
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

# --- Admin dashboard ---
# Admin login password for https://admin-mana.gocinema.io.vn
ADMIN_PASSWORD=levuphong
# Session-signing secret (rotating it logs everyone out — safe)
SESSION_SECRET=bd7060b76893d957cde4c62181c1b9443d91f0c1e686835f52f4cdd3d6ef6520
# CORS allowlist — must match the public dashboard origin
CORS_ORIGINS=https://admin-mana.gocinema.io.vn
# Set true because the dashboard is served over HTTPS
COOKIE_SECURE=true

# --- 9router runtime data ---
NINE_ROUTER_DIR=/home/ubuntu/.9router
# Manager SQLite path (must match the file copied in §2.1)
KEY_MANAGER_DB=/home/ubuntu/.local/state/9router-key-manager/manager.sqlite
# Pre-built dashboard bundle (run `npm run build` if missing)
WEB_ROOT=/home/ubuntu/9router-key-manager/dist/web
# 9router upstream API the watcher polls
NINE_ROUTER_UPSTREAM=http://127.0.0.1:20128

# --- Watcher ---
WATCH_INTERVAL_MS=60000
# Hard-disable key on quota breach (writes back to 9router db.json).
# MUST be true to preserve current behavior.
HARD_DISABLE=true

# --- API-key / traffic shaping ---
API_KEY_CACHE_TTL_MS=5000
TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
TRAFFIC_LARGE_CONTEXT_TOKENS=100000
TRAFFIC_LOG_LIMITER_SNAPSHOT=false

# --- Telegram bot (GoCinema Assistant) ---
TELEGRAM_BOT_TOKEN=8903974115:AAEankpkflPNxXfThmayJtl2nlDQwqrRM7s
BOT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
BOT_POLL_TIMEOUT_SECONDS=30
BOT_REQUEST_TIMEOUT_SECONDS=15
BOT_ALERT_CHECK_INTERVAL_SECONDS=300
BOT_ALERT_BATCH_LIMIT=50
BOT_DEFAULT_ALERT_THRESHOLD_PERCENT=10
BOT_TIMEZONE_OFFSET_HOURS=7
```

### 3.1 About `KEY_MANAGER_DB`

The bot's `src/bot/database.ts` currently opens the DB via a
hard-coded path (~/.local/state/9router-key-manager/manager.sqlite),
not via `KEY_MANAGER_DB`. The systemd example sets `KEY_MANAGER_DB`,
but **bot code does not read it**. As long as the hard-coded path on
the new host matches the file you copy in §2.1, no change is needed.

### 3.2 About `ADMIN_PASSWORD`, `SESSION_SECRET`

If you want to **rotate** these on the new host (recommended when
moving to a fresh server), generate fresh values:

```bash
# ADMIN_PASSWORD — pick something strong; this is what you type to log in
NEW_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)
echo "ADMIN_PASSWORD=$NEW_ADMIN_PASSWORD"

# SESSION_SECRET — 64 hex chars
NEW_SESSION_SECRET=$(openssl rand -hex 32)
echo "SESSION_SECRET=$NEW_SESSION_SECRET"
```

Rotating `SESSION_SECRET` invalidates existing dashboard sessions —
that's the desired effect. `ADMIN_PASSWORD` rotation: you'll need the
new password to log into the new dashboard.

### 3.3 About `TELEGRAM_BOT_TOKEN`

This is the **same token** issued by BotFather for
`@gocinema_assistant_bot`. The token does NOT change when you move
servers — Telegram identifies the bot by this token, not by IP.
Reusing the same token means:

- The webhook registration (if any) stays valid.
- Long-polling resumes seamlessly once the bot process connects to
  Telegram from the new IP.

---

## 4. Step-by-step bring-up on the new server

Run all commands as `ubuntu` unless noted. `sudo` is used only for
systemd and `/etc/` writes.

### 4.1 Lay down the env file

```bash
# After copying /etc/9router-key-manager.env from old host
sudo chown root:root /etc/9router-key-manager.env
sudo chmod 0640      /etc/9router-key-manager.env
sudo ls -l /etc/9router-key-manager.env
# -rw-r----- 1 root root 1678 Aug  3 21:30 /etc/9router-key-manager.env
```

### 4.2 Lay down the repo and install deps

```bash
# After rsync'ing the repo to /home/ubuntu/9router-key-manager/
cd /home/ubuntu/9router-key-manager
nvm use 24.18.0                       # or ensure PATH includes nvm node
npm ci                                # installs from package-lock.json
npm run build                         # produces dist/web/
ls dist/web/ | head -3                # should show index.html etc.
```

### 4.3 Lay down 9router data + manager SQLite

```bash
# After rsync of /home/ubuntu/.9router/
mkdir -p /home/ubuntu/.9router
cp -a /tmp/migrate/dot-9router/. /home/ubuntu/.9router/

# Manager SQLite — keep file ownership and mode
mkdir -p /home/ubuntu/.local/state/9router-key-manager
cp -a /tmp/migrate/manager-db/* \
      /home/ubuntu/.local/state/9router-key-manager/

# Sanity-check SQLite integrity
sqlite3 /home/ubuntu/.local/state/9router-key-manager/manager.sqlite \
        "PRAGMA integrity_check;"
# expected: ok
```

### 4.4 Install systemd units

```bash
sudo cp /tmp/migrate/9router-key-manager.service \
        /etc/systemd/system/9router-key-manager.service
sudo cp /tmp/migrate/gocinema-assistant-bot.service \
        /etc/systemd/system/gocinema-assistant-bot.service

sudo systemctl daemon-reload
```

### 4.5 Start API server

```bash
sudo systemctl enable --now 9router-key-manager
sudo systemctl status 9router-key-manager --no-pager
# Expect: Active: active (running)
```

Verify it answers:

```bash
curl -fsS http://127.0.0.1:3000/api/health
# Expect: {"ok":true,...} or similar
```

If it doesn't start, the most common cause is `better-sqlite3` not
having compiled correctly — re-run `npm rebuild better-sqlite3`.

### 4.6 Start the bot

```bash
sudo systemctl enable --now gocinema-assistant-bot
sudo systemctl status gocinema-assistant-bot --no-pager
# Expect: Active: active (running)
```

The bot unit has `Requires=9router-key-manager.service`, so systemd
will refuse to start it if the API is down.

---

## 5. Verification

### 5.1 Confirm the bot process has the right env

```bash
PID=$(systemctl show -p MainPID gocinema-assistant-bot.service --value)
sudo tr '\0' '\n' < /proc/$PID/environ \
  | grep -E '^(TELEGRAM|BOT_)' | sort
```

Expected output (9 lines):

```
BOT_ALERT_BATCH_LIMIT=50
BOT_ALERT_CHECK_INTERVAL_SECONDS=300
BOT_DEFAULT_ALERT_THRESHOLD_PERCENT=10
BOT_POLL_TIMEOUT_SECONDS=30
BOT_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
BOT_REQUEST_TIMEOUT_SECONDS=15
BOT_TIMEZONE_OFFSET_HOURS=7
TELEGRAM_BOT_TOKEN=8903974115:AAEankpkflPNxXfThmayJtl2nlDQwqrRM7s
```

### 5.2 Confirm API env is right

```bash
PID=$(systemctl show -p MainPID 9router-key-manager.service --value)
sudo tr '\0' '\n' < /proc/$PID/environ \
  | grep -E '^(ADMIN_|NINE_|KEY_MANAGER|WEB_|CORS_|COOKIE_|SESSION_|HARD_|TRAFFIC_|API_KEY_|WATCH_|NODE_ENV|HOST|PORT)' \
  | sort
```

Should show all 19 vars listed in §3.

### 5.3 End-to-end smoke test

1. **Dashboard:** open `https://admin-mana.gocinema.io.vn` in a
   browser, log in with `ADMIN_PASSWORD=levuphong` (or the rotated
   value). Confirm the keys list renders. If you see "Not Found" or
   502, your reverse proxy isn't pointed at the new server yet — see
   §6.2.

2. **Bot — basic:** open Telegram, message
   `@gocinema_assistant_bot`, send `/start`. Expect the inline quota
   screen. If the bot doesn't reply at all:
   - `sudo journalctl -u gocinema-assistant-bot -n 50` — look for
     `TELEGRAM_BOT_TOKEN is required` or `ETIMEDOUT` to
     `api.telegram.org`.
   - Confirm outbound HTTPS works: `curl -fsS https://api.telegram.org`.

3. **Bot — refresh:** tap the **Refresh** button. The bot calls
   `BOT_PUBLIC_API_BASE_URL/api/public/key-check`. If you get a
   generic error, check the API service is up and that the path
   matches (`curl -X POST http://127.0.0.1:3000/api/public/key-check`).

4. **Bot — alerts:** send `/alerts_on`. The watcher (in the API
   service) computes quotas and enqueues alert jobs; the bot drains
   them every `BOT_ALERT_CHECK_INTERVAL_SECONDS` (300s by default).
   Expect no immediate notification if you're under threshold.

5. **Watcher parity:** the API service runs a watcher every
   `WATCH_INTERVAL_MS` (60s). After 1 minute on the new host, check:
   ```bash
   sudo journalctl -u 9router-key-manager --since "1 min ago" | grep -i watch
   ```
   Should see "watcher ran" type log lines.

---

## 6. Cutover details

### 6.1 When to flip

You don't need to flip anything at the **Telegram layer** — the bot
keeps the same `@gocinema_assistant_bot` identity and the same
`TELEGRAM_BOT_TOKEN`. As soon as the bot process on the new host
opens its long-poll to `api.telegram.org`, Telegram routes new
messages to it. The old host should be **stopped first** to avoid
two bots racing for the same `/getUpdates` cursor.

Recommended sequence:

```bash
# On OLD host — keep API + bot running until DNS/proxy is pointed at NEW
# (the rest of this section happens with the OLD host still up)

# 1. On NEW host: bring everything up (§4)
# 2. Verify §5 fully passes on NEW host
# 3. Update reverse proxy (e.g. Caddy / nginx) so admin-mana.gocinema.io.vn
#    → NEW_HOST:3000
# 4. Verify dashboard works via the public URL
# 5. Then on OLD host:
sudo systemctl stop gocinema-assistant-bot
sudo systemctl stop 9router-key-manager
# 6. Leave OLD host offline (or remove the units) to prevent dual-running
```

### 6.2 Reverse proxy reminder

The current reverse-proxy config (Caddy or nginx, wherever it lives)
maps `admin-mana.gocinema.io.vn → 127.0.0.1:3000` on the **old**
host. After migration you have two choices:

- **Move the proxy to the new host** (recommended for a clean
  single-tenant deploy). Update the DNS A record for
  `admin-mana.gocinema.io.vn` to the new server's public IP, and
  have the new host run its own Caddy/nginx in front of port 3000.
  The systemd unit only binds `127.0.0.1:3000`, so the proxy on the
  same host is fine.
- **Keep the proxy on the old host** pointing at the new server's
  `:3000` over the internal network. Simpler if the old host is
  staying up as a bastion.

If `CORS_ORIGINS` ever needs to change (e.g. you move to a different
admin subdomain), update it in `/etc/9router-key-manager.env` and
restart the API service. Cookie issues after a domain change usually
trace back to `CORS_ORIGINS` or `COOKIE_SECURE`.

---

## 7. Rollback

If something breaks on the new host after cutover:

```bash
# 1. Stop the new-host services
sudo systemctl stop gocinema-assistant-bot 9router-key-manager

# 2. Re-point the reverse proxy at the OLD host (still running? then nothing to do)

# 3. Restart OLD host services (if they were stopped)
sudo systemctl start 9router-key-manager gocinema-assistant-bot

# 4. The OLD bot re-registers with Telegram on its next poll
```

Because `TELEGRAM_BOT_TOKEN` is the same, no Telegram-side
reconfiguration is needed for rollback.

---

## 8. Post-migration cleanup

On the OLD host, after you're confident:

```bash
sudo systemctl disable --now 9router-key-manager gocinema-assistant-bot
# Keep the source tree + SQLite + 9router data for at least 7 days
# in case you need to roll back or audit.
```

Rotate these on the NEW host soon after cutover (recommended):

- `ADMIN_PASSWORD` (anyone who had the old password loses access).
- `SESSION_SECRET` (logs out any stale sessions).

After updating the env file:

```bash
sudo systemctl restart 9router-key-manager gocinema-assistant-bot
```

---

## 9. Reference — full systemd units as deployed today

These are the **exact** units on the current host, included so the
new host can `cp` them in place.

### 9.1 `/etc/systemd/system/9router-key-manager.service`

```ini
[Unit]
Description=9router Key Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/9router-key-manager
EnvironmentFile=/etc/9router-key-manager.env
Environment=PATH=/home/ubuntu/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/ubuntu/.nvm/versions/node/v24.18.0/bin/npm run start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 9.2 `/etc/systemd/system/gocinema-assistant-bot.service`

```ini
[Unit]
Description=GoCinema Assistant Telegram Bot
After=network-online.target 9router-key-manager.service
Wants=network-online.target
Requires=9router-key-manager.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/9router-key-manager
EnvironmentFile=/etc/9router-key-manager.env
Environment=PATH=/home/ubuntu/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/home/ubuntu/.nvm/versions/node/v24.18.0/bin/npm run start:bot
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

If the new host doesn't use nvm and Node lives at
`/usr/bin/node`, replace the `PATH=` and `ExecStart=` lines
accordingly. The rest is identical.

---

## 10. Quick command checklist (copy-paste)

```bash
# === ON OLD HOST ===
sudo systemctl stop gocinema-assistant-bot 9router-key-manager
rsync -a --exclude='node_modules' --exclude='.git' \
  /home/ubuntu/9router-key-manager/ /tmp/mig-repo/
rsync -a /home/ubuntu/.9router/ /tmp/mig-9router/
cp -a /home/ubuntu/.local/state/9router-key-manager/. /tmp/mig-db/
sudo cp /etc/9router-key-manager.env /tmp/mig.env
sudo cp /etc/systemd/system/9router-key-manager.service /tmp/mig-api.service
sudo cp /etc/systemd/system/gocinema-assistant-bot.service /tmp/mig-bot.service

# === TRANSFER ===
scp -r /tmp/mig-repo /tmp/mig-9router /tmp/mig-db ubuntu@NEW:/tmp/
scp /tmp/mig.env ubuntu@NEW:/tmp/
scp /tmp/mig-api.service /tmp/mig-bot.service ubuntu@NEW:/tmp/

# === ON NEW HOST ===
cd /home/ubuntu && sudo mv /tmp/mig-repo 9router-key-manager
sudo chown -R ubuntu:ubuntu /home/ubuntu/9router-key-manager
mv /tmp/mig-9router /home/ubuntu/.9router
sudo mkdir -p /home/ubuntu/.local/state/9router-key-manager
sudo mv /tmp/mig-db/* /home/ubuntu/.local/state/9router-key-manager/
sudo chown -R ubuntu:ubuntu /home/ubuntu/.9router /home/ubuntu/.local

sudo mv /tmp/mig.env /etc/9router-key-manager.env
sudo chown root:root /etc/9router-key-manager.env
sudo chmod 0640      /etc/9router-key-manager.env

sudo mv /tmp/mig-api.service /etc/systemd/system/9router-key-manager.service
sudo mv /tmp/mig-bot.service /etc/systemd/system/gocinema-assistant-bot.service

cd /home/ubuntu/9router-key-manager
nvm use 24.18.0
npm ci
npm run build

sudo apt-get install -y build-essential python3
sudo systemctl daemon-reload
sudo systemctl enable --now 9router-key-manager
sleep 2
sudo systemctl enable --now gocinema-assistant-bot
sudo systemctl status 9router-key-manager gocinema-assistant-bot --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

If every command returns clean, the bot is live on the new host.

---

## 11. What to NOT commit to git

This file contains:

- `TELEGRAM_BOT_TOKEN` — BotFather token (rotating this requires
  re-issuing via BotFather)
- `ADMIN_PASSWORD` — admin dashboard login
- `SESSION_SECRET` — session signing key

Before `git add` of this file, either:

1. Add `docs/ops/bot-server-migration-runbook.md` to `.gitignore`, OR
2. Move the file outside the repo (e.g. `/root/migration-runbook.md`
   on the operator's workstation), OR
3. Strip the secret values and rely on `§3` being a template only.

The repo's existing `.gitignore` blocks `.env*` but not `.md`. **Add
the line below if you keep this file inside the repo:**

```
# Bot migration runbook — contains live secrets
docs/ops/bot-server-migration-runbook.md
```
