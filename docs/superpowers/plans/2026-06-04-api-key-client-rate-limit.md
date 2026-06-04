# API-Key Client Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-configurable API-key client rate limiting to `/v1/*` with defaults of 30 RPM and 5 concurrent requests per key.

**Architecture:** Add a focused in-memory `ClientRateLimiter` service and persisted config store backed by `app_settings`. Wire it after key expiry/quota checks and before proxying, release leases around buffered and streaming responses, and expose config in the existing admin traffic tab.

**Tech Stack:** TypeScript, Fastify, React, better-sqlite3, Vitest.

---

### Task 1: Runtime Limiter

**Files:**
- Create: `src/server/services/clientRateLimiter.ts`
- Create: `src/server/services/clientRateLimiter.test.ts`
- Modify: `src/shared/types.ts`

- [x] Write failing tests for RPM, concurrency, independent API keys, disabled config, and 429 body shape.
- [x] Run `npm test -- src/server/services/clientRateLimiter.test.ts` and confirm the tests fail before implementation.
- [x] Implement rolling 60-second RPM and active lease concurrency limiting.
- [x] Run `npm test -- src/server/services/clientRateLimiter.test.ts` and confirm pass.

### Task 2: Persisted Config

**Files:**
- Create: `src/server/services/clientRateLimitConfig.ts`
- Create: `src/server/services/clientRateLimitConfig.test.ts`

- [x] Write failing tests for defaults, normalization, invalid JSON fallback, and cached store save behavior.
- [x] Store config under `client_rate_limit_config` in `app_settings`.
- [x] Run `npm test -- src/server/services/clientRateLimitConfig.test.ts` and confirm pass.

### Task 3: Server Hot Path

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/services/trafficLog.ts`
- Modify: `src/server/services/trafficLog.test.ts`

- [x] Acquire a client limiter lease after key expiry/quota checks.
- [x] Return `429`, `retry-after`, and `x-ratelimit-reset` when RPM or concurrency is exceeded.
- [x] Release leases on image proxy completion, proxy failures, and model stream close/error/end.
- [x] Add client limiter metadata to compact traffic logs.

### Task 4: Admin UI

**Files:**
- Modify: `src/client/AdminTraffic.tsx`
- Modify: `src/client/Dashboard.tsx`
- Modify: `src/client/style.css`

- [x] Load `GET /api/client-rate-limit/config` during dashboard refresh.
- [x] Save `PUT /api/client-rate-limit/config` without restarting the service.
- [x] Add traffic-tab controls for enable, RPM, and concurrency.

### Task 5: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/ops/9router-traffic-timeouts.md`

- [x] Document defaults, UI config, error behavior, log search, and rollback.
- [x] Run full verification: `npm test`, `./node_modules/.bin/tsc --noEmit`, `npm run build`, and `npm run lint`.
