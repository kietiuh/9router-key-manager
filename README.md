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

## Operations runbooks

- Public 9router lag mitigation and VPS rebuild steps: [`docs/ops/9router-public-lag-mitigation.md`](docs/ops/9router-public-lag-mitigation.md).
- Traffic queue and upstream generation timeout policy: [`docs/ops/9router-traffic-timeouts.md`](docs/ops/9router-traffic-timeouts.md).

Run the 9router observability mitigation in dry-run mode:

```bash
npm run ops:mitigate-9router-observability
```

Apply it during an approved production window:

```bash
npm run ops:mitigate-9router-observability -- --apply
```

When production routing, service paths, ports, 9router versions, or mitigation settings change, update the matching runbook in the same commit.

## Config

Copy `.env.example` to `.env` if you need overrides.

Important variables:

- `ADMIN_PASSWORD`: required admin password; the server refuses to start without it.
- `NINE_ROUTER_DIR`: path containing 9router `db.json` and `usage.json`; defaults to `~/.9router`.
- `KEY_MANAGER_DB`: SQLite path for manager metadata; defaults to `~/.local/state/9router-key-manager/manager.sqlite`.
- `HARD_DISABLE`: set to `true` only when you want quota breaches with action `disable` to modify 9router `db.json`.
- `CORS_ORIGINS`: comma-separated allowed UI origins; defaults to local Vite origins.
- `COOKIE_SECURE`: override secure-cookie behavior; defaults to secure in production only.
- `NINE_ROUTER_UPSTREAM`: 9router API base URL; production uses `http://127.0.0.1:20128`.
- `IMAGE_PROXY_API_KEY`: server-side image upstream key for `authMode: server-key`; never expose or commit it.

## Public image creator

A public user-facing image page exists at:

```text
/images
/image
```

Users paste an active GoCinema key, enter a prompt, optionally optimize it, generate an image, preview it, then download the PNG. The page is public, but API calls require a valid active GoCinema key.

Relevant APIs:

- `POST /api/public/images/optimize-prompt`
- `POST /api/public/images/generate`
- `POST /v1/images/generations` remains the direct OpenAI-compatible image proxy.

Production currently serves this at:

```text
https://user.gocinema.io.vn/images
```

Production image proxy expectations:

```json
{
  "enabled": true,
  "upstreamBaseUrl": "https://shopapikey.com/v1",
  "authMode": "server-key",
  "modelOverride": "cx/gpt-5.4-image"
}
```

Implementation/deploy docs: [`docs/public-image-creator.md`](docs/public-image-creator.md).

## Concepts

### Usage window

Each key has policy metadata in SQLite:

- `window_start`
- `window_end`
- `token_limit`
- `expires_at`
- `action_on_limit`: `alert`, `disable`, or `none`

Current usage is computed by summing `usage.json.history` records matching that API key and inside the window. Daily/monthly windows reset automatically on UTC+7 boundaries; manual reset only applies to `manual` and `custom` policies.

### Hard disable

When enabled, the watcher can set the target key's `isActive=false` inside 9router `db.json`. This may require 9router reload/restart depending on 9router runtime behavior.

## Current endpoints

- `GET /api/health`
- `POST /api/public/key-check`
- `POST /api/public/images/optimize-prompt`
- `POST /api/public/images/generate`
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
