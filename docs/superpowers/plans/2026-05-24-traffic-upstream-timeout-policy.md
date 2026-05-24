# Traffic Upstream Timeout Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate upstream generation deadlines from traffic queue wait limits so slow GPT-5.5 `/v1/responses` requests are not retried from scratch at 120 seconds.

**Architecture:** Keep `TRAFFIC_MODEL_LIMITS` focused on concurrency and backward-compatible base timeouts. Add explicit upstream timeout overrides with normal and large-context values, keep queue wait timeout as its own setting, and log the selected upstream timeout on both success and timeout fallback paths.

**Tech Stack:** TypeScript, Fastify, Vitest, systemd runtime environment, GitHub PR workflow.

---

### Task 1: Traffic Limiter Timeout Config

**Files:**
- Modify: `src/server/services/trafficLimiter.ts`
- Create: `src/server/services/trafficLimiter.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that prove `TRAFFIC_UPSTREAM_TIMEOUTS` controls upstream deadlines and `TRAFFIC_QUEUE_TIMEOUT_MS` controls queue waiting independently.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- src/server/services/trafficLimiter.test.ts`

Expected: fail because `readTrafficLimitConfig()` does not parse `TRAFFIC_UPSTREAM_TIMEOUTS` or `TRAFFIC_QUEUE_TIMEOUT_MS`.

- [ ] **Step 3: Implement minimal config support**

Add `queueTimeoutMs`, optional large queue timeout, and `upstreamTimeouts` to `TrafficLimitConfig`. Parse:

```text
TRAFFIC_UPSTREAM_TIMEOUTS=model:normalMs:largeMs,*:normalMs:largeMs
TRAFFIC_QUEUE_TIMEOUT_MS=120000
TRAFFIC_LARGE_CONTEXT_QUEUE_TIMEOUT_MS=120000
```

Use upstream timeout for `TrafficLease.timeoutMs`; use queue timeout only in `LimitGroup.acquire()`.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- src/server/services/trafficLimiter.test.ts`

Expected: pass.

### Task 2: Proxy Failover Observability

**Files:**
- Modify: `src/server/services/proxyFailover.ts`
- Modify: `src/server/services/proxyFailover.test.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving timeout retry logs include `timeoutMs`, request size, token estimate, and large-context flag, and successful proxy results expose the selected timeout for server logs.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- src/server/services/proxyFailover.test.ts`

Expected: fail because timeout metadata is not logged or returned yet.

- [ ] **Step 3: Implement logging and result metadata**

Add `timeoutMs` to `FetchUpstreamResult`. Log `timeoutMs`, `bodyBytes`, `estimatedInputTokens`, and `isLargeContext` when retrying after timeout or proxy error. Include `upstreamTimeoutMs` in the server access log.

- [ ] **Step 4: Run targeted tests**

Run: `npm test -- src/server/services/proxyFailover.test.ts`

Expected: pass.

### Task 3: Ops Documentation

**Files:**
- Create: `docs/ops/9router-traffic-timeouts.md`
- Modify: `.env.example`

- [ ] **Step 1: Document the production timeout policy**

Document the recommended production values:

```ini
TRAFFIC_MODEL_LIMITS=cx/gpt-5.5:3:30:120000,v1/cx/gpt-5.5:3:30:120000,*:20:100:120000
TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
TRAFFIC_QUEUE_TIMEOUT_MS=120000
TRAFFIC_LARGE_CONTEXT_QUEUE_TIMEOUT_MS=120000
```

Explain that fallback after timeout is still a hard safety path, but the timeout is now high enough to avoid unnecessary retry-from-scratch for normal slow completions.

- [ ] **Step 2: Update environment example**

Add the new environment variables to `.env.example` with concise comments.

### Task 4: Validation, PR, Merge, Deploy

**Files:**
- All modified files

- [ ] **Step 1: Run full validation**

Run:

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run build
npm run lint
```

- [ ] **Step 2: Commit and push**

Commit all source and docs changes, push `feature/traffic-upstream-timeout-policy`, and create a PR.

- [ ] **Step 3: Merge and deploy**

Merge PR to `main`, update local `main`, restart `9router-key-manager`, and apply the new systemd environment values.

- [ ] **Step 4: Verify production**

Verify `systemctl show`, `/api/health`, public endpoints, and recent journals. Confirm the live environment includes `TRAFFIC_UPSTREAM_TIMEOUTS` and no new timeout fallback loop appears after restart.
