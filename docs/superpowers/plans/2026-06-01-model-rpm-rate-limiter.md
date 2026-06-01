# Model RPM Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current concurrent traffic limiter on `/v1/*` proxy attempts with an admin-configurable per-model RPM limiter that releases matching model requests at an even interval.

**Architecture:** Add a focused `ModelRateLimiter` service that stores per-model scheduling queues in memory and reads normalized configuration from `app_settings`. Wire it inside `fetchUpstreamWithFailover()` per attempt, after rewrite/failover has selected the target model, so direct calls, rewritten calls, and fallback attempts are all limited by the final model name. Remove the existing concurrent limiter from the hot path and expose the new config/status in the admin traffic panel.

**Tech Stack:** TypeScript, Fastify, React, better-sqlite3, Vitest.

---

### Task 1: Add Model RPM Limiter Core

**Files:**
- Create: `src/server/services/modelRateLimiter.ts`
- Create: `src/server/services/modelRateLimiter.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing tests**

Add tests in `src/server/services/modelRateLimiter.test.ts` for:
- `12rpm` on `v4/gpt-5.5` spaces queued leases by `5000ms`.
- Unconfigured models pass immediately.
- Queue limit rejects extra matching requests with a `model rate queue full` error.
- Max queue wait rejects a queued request before its scheduled slot.

Run: `npm test -- src/server/services/modelRateLimiter.test.ts`
Expected: FAIL because `modelRateLimiter.ts` does not exist.

- [ ] **Step 2: Implement the core limiter**

Create `ModelRateLimiter` with these exported pieces:
- `ModelRateLimitConfig`
- `ModelRateLimitRule`
- `ModelRateLimitLease`
- `ModelRateLimitAcquireError`
- `normalizeModelRateLimitConfig(input)`
- `defaultModelRateLimitConfig()`
- `ModelRateLimiter.acquire(model)`
- `ModelRateLimiter.snapshot()`
- `ModelRateLimiter.updateConfig(config)`

Semantics:
- If global config is disabled, rule is disabled, rule missing, or `rpm <= 0`, return immediately with `rateLimited=false`.
- For a matching enabled rule, compute interval as `Math.ceil(60000 / rpm)`.
- First request may pass immediately when `nextAvailableAt <= now`.
- Later matching requests wait until their reserved time.
- Each queued request reserves the next slot at enqueue time, so release timing is independent of upstream response duration.
- Queue length is bounded by `queueLimit`.
- If the reserved delay is greater than `maxQueueWaitMs`, reject with `model rate queue timeout`.

Run: `npm test -- src/server/services/modelRateLimiter.test.ts`
Expected: PASS.

### Task 2: Persist Admin Config

**Files:**
- Create: `src/server/services/modelRateLimitConfig.ts`
- Create: `src/server/services/modelRateLimitConfig.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing config tests**

Add tests for:
- default config is disabled with no rules.
- saving trims model names, removes invalid blank rules, normalizes numbers, and stores JSON under `app_settings.key = 'model_rate_limit_config'`.
- loading invalid JSON falls back to defaults.

Run: `npm test -- src/server/services/modelRateLimitConfig.test.ts`
Expected: FAIL because the config service does not exist.

- [ ] **Step 2: Implement persistence**

Implement:
- `getModelRateLimitConfig(db)`
- `saveModelRateLimitConfig(db, config)`
- `createModelRateLimitConfigStore(db)`

Use the existing `app_settings` pattern from image proxy/final fallback services. The store keeps an in-memory cached config for the hot path and refreshes when admin saves.

Run: `npm test -- src/server/services/modelRateLimitConfig.test.ts`
Expected: PASS.

### Task 3: Wire Proxy Attempts To RPM Limiter

**Files:**
- Modify: `src/server/services/proxyFailover.ts`
- Modify: `src/server/services/proxyFailover.test.ts`
- Modify: `src/server/index.ts`
- Create: `src/server/services/upstreamTimeouts.ts`
- Create: `src/server/services/upstreamTimeouts.test.ts`
- Delete: `src/server/services/trafficLimiter.ts`
- Delete: `src/server/services/trafficLimiter.test.ts`

- [ ] **Step 1: Write failing proxy tests**

Update proxy failover tests so `fetchUpstreamWithFailover()` accepts `modelRateLimiter` instead of `trafficLimiter`.
Add tests proving:
- a direct attempt calls `modelRateLimiter.acquire('v4/gpt-5.5')`.
- a failover second attempt calls acquire for the second target model.
- an acquire rejection returns `TrafficAcquireError` with limiter snapshot and model.

Run: `npm test -- src/server/services/proxyFailover.test.ts`
Expected: FAIL because the production signature still expects `trafficLimiter`.

- [ ] **Step 2: Replace hot-path limiter**

Change `fetchUpstreamWithFailover()` to call `modelRateLimiter.acquire(model)` per attempt. Keep returned metadata:
- `rateQueuedMs`
- `rateLimitModel`
- `rateLimitRpm`
- `rateLimited`

Remove concurrent limiter construction from `src/server/index.ts`. Keep upstream timeout policy by moving timeout reads into `src/server/services/upstreamTimeouts.ts`.

Run: `npm test -- src/server/services/proxyFailover.test.ts src/server/services/upstreamTimeouts.test.ts`
Expected: PASS.

### Task 4: Add API And Admin UI

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/client/Dashboard.tsx`
- Modify: `src/client/AdminTraffic.tsx`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing UI/API tests where practical**

Extend existing client/server tests if available:
- Type/API shape includes `ModelRateLimitConfig`.
- Admin traffic panel can render and save RPM config through provided props.

Run: `npm test -- src/client/api.test.ts src/client/adminTabs.test.ts src/server/services/modelRateLimitConfig.test.ts`
Expected: existing tests pass, new compile/type checks fail until UI/API types are wired.

- [ ] **Step 2: Implement admin endpoints and UI**

Add protected routes:
- `GET /api/model-rate-limit/config`
- `PUT /api/model-rate-limit/config`

In the traffic panel, show a compact config section:
- global enable checkbox.
- list of per-model rules.
- inputs for model, enabled, RPM, queue limit, max queue wait seconds.
- add/remove rule.
- save button.

Update `Dashboard` refresh/save flow to load and save the config.

Run: `npm test -- src/client/api.test.ts src/client/adminTabs.test.ts src/server/services/modelRateLimitConfig.test.ts`
Expected: PASS.

### Task 5: Logs, Docs, And Full Verification

**Files:**
- Modify: `src/server/services/trafficLog.ts`
- Modify: `src/server/services/trafficLog.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create or modify: `docs/ops/9router-traffic-timeouts.md`

- [ ] **Step 1: Write failing log test**

Update `trafficLog.test.ts` to expect compact success logs to include:
- `rateQueuedMs`
- `rateLimitModel`
- `rateLimitRpm`
- `rateLimited`

Run: `npm test -- src/server/services/trafficLog.test.ts`
Expected: FAIL until log metadata is extended.

- [ ] **Step 2: Implement logs and docs**

Extend traffic log metadata and admin docs. Document that model RPM limiting is runtime/admin-managed, while upstream generation timeout env vars remain systemd-controlled.

Run:
- `npm test`
- `./node_modules/.bin/tsc --noEmit`
- `npm run build`
- `npm run lint`

Expected: all commands exit 0.

### Task 6: Branch Completion

**Files:**
- Review all changed files with `git diff`.

- [ ] **Step 1: Self-review**

Review the diff for:
- No concurrent limiter still active on `/v1/*`.
- RPM limiting happens per final attempt model.
- Queue failures return `429` with retry metadata.
- Admin changes update the runtime store without restart.

- [ ] **Step 2: Commit, PR, and deploy path**

Commit branch after verification. If remote auth is available, create PR, review diff, merge per repo workflow, restart `9router-key-manager.service`, then verify health and public endpoints.
