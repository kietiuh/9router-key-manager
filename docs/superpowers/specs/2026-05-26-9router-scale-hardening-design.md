# 9router Scale Hardening Design

## Goal

Prepare the current single-VPS 9router + key-manager setup for higher client traffic without replacing SQLite prematurely.

## Current Findings

- `gocinema.io.vn /v1/*` flows through `9router-key-manager` on port 3000, then upstreams to 9router on port 20128.
- Recent key-manager traffic is not queue-bound: recent `queuedMs` p95 was about 1ms and no queue rejections were seen.
- 9router detailed request capture is already disabled and `requestDetails` is empty after cleanup.
- `manager.sqlite` growth is mostly `usage_events` plus indexes. Existing rows contain duplicate logical usage records because the stored unique signature includes `cost`, while quota summarization dedupes without `cost`.
- Direct public access to ports 3000 and 20128 increases scan noise and bypasses Caddy route policy.

## Design

Keep SQLite for the current single-node control plane, but reduce hot-path overhead and storage growth:

- Add an API-key cache for request-time lookup, with a short TTL and explicit invalidation hooks.
- Align usage-event ingest signatures with quota dedupe semantics so repeated imports do not keep creating logical duplicates.
- Add a dry-run-first storage maintenance command that backs up the DB, dedupes existing usage events, rewrites signatures to the canonical form, cleans expired public images, and optionally vacuums.
- Reduce successful proxy log payload by omitting limiter snapshots by default. Keep queue/failure logs detailed.
- Document and apply runtime hardening through systemd drop-ins: listen locally, cap journald storage, and keep Caddy as the public entry point.

## Verification

- Unit tests cover API-key cache behavior, traffic log metadata, canonical usage signatures, DB dedupe, and expired public-image cleanup.
- Full repo validation remains `npm test`, `./node_modules/.bin/tsc --noEmit`, `npm run build`, and `npm run lint`.
- Live verification checks systemd service state, listening addresses, `/api/health`, public `/check`, public `/v1/models`, DB row counts, and journald disk usage.
