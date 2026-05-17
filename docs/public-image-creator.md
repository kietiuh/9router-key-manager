# Public Image Creator

Public image creation page for GoCinema users.

- Page: `/images` (alias: `/image`)
- Public APIs:
  - `POST /api/public/images/optimize-prompt`
  - `POST /api/public/images/generate`
- Existing direct image proxy remains available at `/v1/images/generations` and `/v1/images/edits`.

The goal is to let a user paste a GoCinema key, enter an image prompt, optionally optimize it, generate an image, preview it, then download the PNG. The page is intentionally public but every action must present a valid active GoCinema key.

## User flow

1. User opens `https://user.gocinema.io.vn/images`.
2. User enters a GoCinema key (`sk-...`).
3. User enters an image prompt.
4. Optional: click **Tối ưu prompt**.
   - Server validates the key.
   - Server sanitizes/guards the prompt.
   - Server calls 9router chat with `v1/cx/gpt-5.5`, `stream:true` to rewrite the prompt.
   - If optimize fails or returns empty text, server falls back to deterministic local prompt enhancement.
5. User clicks **Tạo ảnh**.
   - Server validates key + prompt again.
   - Server calls the configured image proxy upstream.
   - Response returns base64 image data to the browser.
6. User previews image and clicks **Download ảnh**.

## Production deployment shape

Current production runs the key-manager service behind Caddy:

```text
Browser
→ https://user.gocinema.io.vn/images
→ Caddy
→ 9router-key-manager on 127.0.0.1:3000
→ public image APIs
→ image upstream https://shopapikey.com/v1
```

Do not assume local defaults match production. Production currently uses port `3000`, not the dev default `3039`.

Production service:

```bash
systemctl status 9router-key-manager
systemctl cat 9router-key-manager
journalctl -u 9router-key-manager -f
```

Current known production values:

```text
Domain: https://user.gocinema.io.vn
Service: 9router-key-manager
Public page: /images
Health: /api/health
Image provider upstream: https://shopapikey.com/v1
Image model override: cx/gpt-5.4-image
Image auth mode: server-key
Server key env: IMAGE_PROXY_API_KEY in /etc/9router-key-manager.env
9router upstream: http://127.0.0.1:20128
```

## Required image proxy config

The public image page uses the same stored image proxy config as `/v1/images/*`.

Expected config:

```json
{
  "enabled": true,
  "upstreamBaseUrl": "https://shopapikey.com/v1",
  "authMode": "server-key",
  "modelOverride": "cx/gpt-5.4-image"
}
```

`authMode: "server-key"` is intentional. Users enter a GoCinema key only to prove they are allowed to use the service. The upstream ShopAPIKey secret must stay server-side.

If `authMode` is changed to `pass-through`, the user's GoCinema key would be sent upstream. Do not do that unless the upstream accepts the same key format and the security model has been reviewed.

## Environment requirements

Minimum server env:

```bash
ADMIN_PASSWORD=...
HOST=127.0.0.1
PORT=3000
NINE_ROUTER_UPSTREAM=http://127.0.0.1:20128
IMAGE_PROXY_API_KEY=...
```

Optional/common:

```bash
NODE_ENV=production
COOKIE_SECURE=true
CORS_ORIGINS=https://admin.gocinema.io.vn,https://user.gocinema.io.vn
KEY_MANAGER_DB=/root/.local/state/9router-key-manager/manager.sqlite
NINE_ROUTER_DIR=/root/.9router
```

Production env file is outside git:

```text
/etc/9router-key-manager.env
```

Never commit real keys or `.env` files.

## Key validation

Public image APIs call `findPublicKey()` against 9router keys loaded by the manager. A key is accepted only if:

- exact key string matches a stored GoCinema/9router key
- key is active (`isActive !== false`)

Invalid or inactive keys return `401`/`404` depending on endpoint.

## Prompt handling

Server-side prompt logic exists to keep image generation closer to prior successful generations and to avoid obvious bad requests.

Current behavior:

- Trim/control-character cleanup.
- Max prompt length: `6000` chars.
- Block simple high-risk patterns:
  - sexual minors / underage explicit content
  - `loli` / `shota`
  - obvious realistic gore terms
- Generation always appends an image-quality suffix:

```text
high quality, coherent composition, sharp focus, detailed lighting,
cinematic color grading, polished digital art, no text, no watermark,
no distorted hands, no extra fingers, no blurry face
```

This is not a full moderation system. If this becomes public-facing at scale, add a stronger moderation layer/rate limit before generating.

## Prompt optimization implementation

Prompt optimization uses chat through 9router:

```text
POST $NINE_ROUTER_UPSTREAM/v1/chat/completions
model: v1/cx/gpt-5.5
stream: true
```

Why `stream:true`?

9router `0.4.50` currently returns content reliably via streaming for ShopAPIKey/CX chat models. Non-stream chat/completions can return `HTTP 200` with empty `message.content` for some converted responses paths.

If stream parsing returns empty, the API uses the local fallback prompt enhancer instead of failing the user.

## Image generation implementation

The generate endpoint calls the configured image upstream using `buildImageProxyUrl(config, '/v1/images/generations')`.

Request body sent upstream:

```json
{
  "model": "cx/gpt-5.4-image",
  "prompt": "<guarded/enhanced prompt>",
  "size": "1024x1024",
  "n": 1
}
```

Allowed sizes from the page/API:

- `1024x1024`
- `1024x1536`
- `1536x1024`

Response expected from upstream:

```json
{
  "data": [
    { "b64_json": "..." }
  ]
}
```

The API returns:

```json
{
  "image": "<base64>",
  "mimeType": "image/png",
  "filename": "gocinema-image-...png",
  "prompt": "<prompt sent upstream>",
  "bytes": 123456
}
```

The browser uses a `data:image/png;base64,...` URL for preview/download.

## Usage logging

Successful and failed public page generations are logged into `image_usage_events` using `kind: "public-page"`.

Logged fields include:

- model
- size
- prompt preview/hash
- status
- image count
- byte size
- error message when failed

Admin UI image usage stats should include these rows.

## Local development without drifting from production

1. Copy `.env.example` to `.env`.
2. Set local values explicitly:

```bash
HOST=127.0.0.1
PORT=3039
ADMIN_PASSWORD=dev-password
NINE_ROUTER_UPSTREAM=http://127.0.0.1:20128
NINE_ROUTER_DIR=/root/.9router
KEY_MANAGER_DB=/tmp/9router-key-manager-dev.sqlite
IMAGE_PROXY_API_KEY=<dev or test upstream key>
```

3. Start 9router locally or tunnel to a safe test 9router.
4. Enable image proxy config in the admin UI or seed app setting to match production:

```json
{"enabled":true,"upstreamBaseUrl":"https://shopapikey.com/v1","authMode":"server-key","modelOverride":"cx/gpt-5.4-image"}
```

5. Run dev:

```bash
npm run dev
```

Local URLs:

```text
UI: http://localhost:5173/images
API: http://127.0.0.1:3039
```

Vite proxies `/api` to `127.0.0.1:3039`, but the production service serves the built UI from `dist/web` on port `3000`. Test both when changing routing/static behavior.

## Production deploy checklist

Before deploy:

```bash
npm run build
npx tsc --noEmit
npm test
```

Backup:

```bash
BACK=/root/.openclaw/workspace/backups/9router-key-manager-image-page-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACK"
cp -a /root/.openclaw/workspace/code/github/9router-key-manager "$BACK/repo"
cp -a /etc/9router-key-manager.env "$BACK/9router-key-manager.env"
systemctl cat 9router-key-manager > "$BACK/9router-key-manager.service"
```

Deploy:

```bash
cd /root/.openclaw/workspace/code/github/9router-key-manager
npm run build
systemctl restart 9router-key-manager
```

Verify:

```bash
systemctl is-active 9router-key-manager
curl -sS http://127.0.0.1:3000/api/health
curl -sS -o /tmp/images-page.html -w 'images_http=%{http_code} size=%{size_download}\n' https://user.gocinema.io.vn/images
curl -sS -o /tmp/check-page.html -w 'check_http=%{http_code} size=%{size_download}\n' https://user.gocinema.io.vn/check
```

Optional API smoke tests with a real active GoCinema key:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/public/images/optimize-prompt \
  -H 'Content-Type: application/json' \
  -d '{"key":"sk-...","prompt":"cute robot cat in neon city"}'
```

```bash
curl -sS -X POST http://127.0.0.1:3000/api/public/images/generate \
  -H 'Content-Type: application/json' \
  -d '{"key":"sk-...","prompt":"cute robot cat in neon city","size":"1024x1024"}'
```

Image generation can take 60-120 seconds depending on upstream.

## Known edge cases

- Non-stream chat completions through 9router/ShopAPIKey may return `200` with empty content; keep optimize on `stream:true`.
- Image generation response can be large (~2 MB base64 for 1024x1024). Avoid putting it into logs.
- The public page route is unauthenticated by design. The API relies on GoCinema key validation; add rate limiting before broad public launch.
- If 9router storage migrates between `db.json` and SQLite, ensure key validation still reads the same source as runtime/UI.

## Reviewer notes for UX hardening changes

This update intentionally keeps the production contract stable:

- `/api/public/images/generate` remains synchronous.
- The response still returns base64 image data in JSON.
- `/images` and `/image` remain public routes.
- Image generation still uses the stored image proxy config.
- `authMode: "server-key"` still keeps `IMAGE_PROXY_API_KEY` server-side.
- Generation still appends the production quality suffix, but the suffix is now idempotent so a fallback-optimized prompt is not duplicated during generation.

Review focus:

- Prompt behavior: `enhanceImagePrompt()` should append the quality suffix once and preserve existing prod wording.
- Error UX: API errors are parsed from both flat `{ "error": "..." }` and nested OpenAI-style `{ "error": { "message": "..." } }` responses before being shown in the browser.
- Public page UX: users can choose whether to remember the GoCinema key, clear it, see a 60-120 second generation hint, and inspect the final upstream prompt.
- Admin observability: dashboard now reads `/api/images/usage` and displays image counts, errors, byte volume, and recent public image/proxy usage rows.
- Config docs: `.env.example` includes local values needed to mirror the production shape without committing secrets.

Suggested review commands:

```bash
npm test
npx tsc --noEmit
npm run build
```

`npm run lint` currently cannot run in this repo because ESLint 10 requires `eslint.config.*` and the repository does not include one yet.
