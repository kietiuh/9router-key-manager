# 9router Key Manager

Local dashboard + API for supervising 9router API-key usage, token limits, expiry dates, usage windows, and optional hard-disable actions.

## Safety model

- Never commits real `~/.9router` data.
- API keys are masked in UI/API summaries.
- Usage reset is **window-based**: it changes `windowStart`; it does **not** edit or delete `usage.json`.
- Hard-disable is opt-in only (`HARD_DISABLE=true`) and writes `~/.9router/db.json` via:
  1. JSON parse/validate
  2. backup `db.json.bak.TIMESTAMP`
  3. atomic temp-file rename
  4. post-write JSON parse/validate
- UI defaults to local dev. Vite binds `0.0.0.0` so the host can access the web UI from a VM; backend defaults to `127.0.0.1`.

## Install

```bash
npm install
```

## Develop

```bash
npm run dev
```

- UI: <http://localhost:5173>
- API: <http://127.0.0.1:3039>

For host access to the UI from a VM, use the VM IP with port `5173`. The Vite dev server proxies `/api` to the local backend.

## Build / test

```bash
npm test
npm run build
```

## Config

Copy `.env.example` to `.env` if you need overrides.

Important variables:

- `NINE_ROUTER_DIR`: path containing 9router `db.json` and `usage.json`; defaults to `~/.9router`.
- `KEY_MANAGER_DB`: SQLite path for manager metadata; defaults to `~/.local/state/9router-key-manager/manager.sqlite`.
- `HARD_DISABLE`: set to `true` only when you want quota breaches with action `disable` to modify 9router `db.json`.

## Concepts

### Usage window

Each key has policy metadata in SQLite:

- `window_start`
- `window_end`
- `token_limit`
- `expires_at`
- `action_on_limit`: `alert`, `disable`, or `none`

Current usage is computed by summing `usage.json.history` records matching that API key and inside the window. Resetting a key only updates `window_start` to now.

### Hard disable

When enabled, the watcher can set the target key's `isActive=false` inside 9router `db.json`. This may require 9router reload/restart depending on 9router runtime behavior.

## Current endpoints

- `GET /api/health`
- `GET /api/keys/usage`
- `PATCH /api/keys/:keyId/policy`
- `POST /api/keys/:keyId/reset-window`
- `POST /api/watcher/run`
- `GET /api/audit`

## Git hygiene

`.gitignore` blocks:

- `.env*` except `.env.example`
- SQLite DBs
- logs/backups/dumps
- `.9router/`
- `db.json`, `usage.json`, `request-details.json`
- `*.bak.*`

Run before pushing:

```bash
git status --short
git grep -n "sk-" -- . ':!package-lock.json'
```
