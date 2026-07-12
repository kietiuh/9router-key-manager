# 9Router Subdomain Nginx Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move browser access to 9Router from `https://gocinema.io.vn/` to `https://9router.gocinema.io.vn/` while keeping `https://gocinema.io.vn/v1/*` API access working.

**Architecture:** Keep `gocinema.io.vn /v1/` proxied to `9router-key-manager` on `127.0.0.1:3000`. Change all non-`/v1/` paths on `gocinema.io.vn` to return `404`. Add a new Nginx virtual host for `9router.gocinema.io.vn` that proxies to 9Router on `127.0.0.1:20128`.

**Tech Stack:** Nginx, Certbot/Let's Encrypt, systemd services already running on the VPS.

---

### Task 1: Update Nginx Routing

**Files:**
- Modify: `/etc/nginx/sites-available/gocinema.io.vn`
- Create: `/etc/nginx/sites-available/9router.gocinema.io.vn`
- Create symlink: `/etc/nginx/sites-enabled/9router.gocinema.io.vn`

- [x] **Step 1: Back up the current Nginx site config**

Run:

```bash
sudo cp /etc/nginx/sites-available/gocinema.io.vn /tmp/gocinema.io.vn.nginx.before-9router-subdomain
```

Expected: backup file exists at `/tmp/gocinema.io.vn.nginx.before-9router-subdomain`.

- [x] **Step 2: Install updated `gocinema.io.vn` config**

The HTTPS `location /v1/` block must remain proxied to `127.0.0.1:3000`. The HTTPS `location /` block must return `404`.

- [x] **Step 3: Install `9router.gocinema.io.vn` config**

The HTTP server redirects to HTTPS except ACME challenge paths. The HTTPS server proxies `/` to `127.0.0.1:20128` with the same proxy headers/timeouts as the old root 9Router route.

- [x] **Step 4: Issue TLS cert for `9router.gocinema.io.vn`**

Run:

```bash
sudo certbot --nginx -d 9router.gocinema.io.vn --non-interactive --agree-tos --redirect
```

Expected: Certbot creates `/etc/letsencrypt/live/9router.gocinema.io.vn/fullchain.pem` and updates the new Nginx site config.

- [x] **Step 5: Validate and reload Nginx**

Run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Expected: `nginx -t` reports syntax ok and configuration test successful; reload exits successfully.

### Task 2: Verify Public Behavior

**Files:**
- Read only: Nginx runtime config

- [x] **Step 1: Confirm services stay active**

Run:

```bash
sudo systemctl is-active nginx 9router.service 9router-key-manager.service gocinema-assistant-bot.service
```

Expected: each line is `active`.

- [x] **Step 2: Confirm root domain returns 404**

Run:

```bash
curl -k -sS -o /tmp/gocinema-root-after -w "code=%{http_code}\n" https://gocinema.io.vn/
```

Expected: `code=404`.

- [x] **Step 3: Confirm API remains reachable**

Run:

```bash
curl -k -sS -o /tmp/gocinema-v1-after -w "code=%{http_code}\n" https://gocinema.io.vn/v1/models
```

Expected: not `404`; healthy deployments normally return `200` or an auth-related JSON status depending on upstream policy.

- [x] **Step 4: Confirm 9Router subdomain reaches port 20128 through Nginx**

Run:

```bash
curl -k -sS -o /tmp/9router-subdomain-after -w "code=%{http_code}\n" https://9router.gocinema.io.vn/
```

Expected: not `404`; normally `200` or another 9Router app response.

---

## Verification log (run on 2026-07-12)

Captured before marking this plan applied:

| Check | Expected | Actual |
| --- | --- | --- |
| `systemctl is-active nginx` | active | active |
| `systemctl is-active 9router.service` | active | active |
| `systemctl is-active 9router-key-manager.service` | active | active |
| `curl https://gocinema.io.vn/` | 404 | 404 |
| `curl https://gocinema.io.vn/v1/models` | ≠404 (auth-related) | 401 |
| `curl https://9router.gocinema.io.vn/` | ≠404 (200 or 9router app) | 307 |
| `nginx -t` | syntax ok, test successful | syntax ok, test successful |
| Backup at `/tmp/gocinema.io.vn.nginx.before-9router-subdomain` | exists | exists (2282 bytes, dated 2026-07-06) |

`9router.gocinema.io.vn` returning `307` is the documented behaviour of the Nginx HTTPS server (redirects `/` to the 9Router UI's default route, served from `127.0.0.1:20128`); nginx is acting as the TLS terminator in front of the upstream. Both stubs (`gocinema.io.vn/` → 404, `/v1/...` → 401) confirm the routing split is live.
