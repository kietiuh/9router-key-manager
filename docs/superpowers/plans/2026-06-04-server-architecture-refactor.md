# Server Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the key-manager server architecture incrementally while preserving current runtime behavior, endpoint contracts, and production safety.

**Architecture:** First make server behavior testable through an app factory and route characterization tests. Then extract duplicated policy/usage projection and route domains from `src/server/index.ts` into focused modules while keeping the original endpoint surface and response shapes stable. Update docs after each phase when code reveals stale assumptions.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, Vite, React.

---

## Phase Rules

- Do not change public behavior intentionally unless a later task explicitly says so.
- Use TDD for runtime changes: write the characterization or unit test first, run it and see the expected failure, then implement the smallest code move.
- After each phase run focused tests, `./node_modules/.bin/tsc --noEmit`, and `npm run lint`.
- Before final completion run `npm test`, `./node_modules/.bin/tsc --noEmit`, `npm run lint`, and `npm run build`.
- Update docs when route inventory, source-of-truth, or operational assumptions change.
- Keep the previous local Phase 0 audit branch out of this implementation branch.

## Target File Structure

- Create `src/server/app.ts`: builds and configures a Fastify app without calling `listen()`.
- Modify `src/server/index.ts`: load dotenv, call `createServerApp()`, start watcher/log metrics, register SPA fallback, and listen.
- Create `src/server/app.test.ts`: route-level characterization tests using `app.inject()`.
- Create `src/server/services/policyUsage.ts`: shared policy resolution, usage import window, usage filters, usage summary cache helper boundaries.
- Modify `src/server/services/watcher.ts`: use shared policy/usage helpers.
- Create `src/server/routes/publicImages.ts`: public image route registration and job endpoint handlers.
- Create `src/server/services/publicImageJobs.ts`: in-memory public image queue and job state.
- Create `src/server/services/publicImageStore.ts`: image usage/file persistence helpers.
- Create `src/server/routes/admin.ts`: authenticated admin routes grouped by current domain.
- Create `src/server/routes/proxy.ts`: `/v1/*` proxy route registration and hot-path orchestration.
- Update `README.md` and `docs/public-image-creator.md`: align route inventory and queued image behavior.

## Task 1: Server App Factory And Route Characterization

**Files:**

- Create: `src/server/app.ts`
- Create: `src/server/app.test.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing app factory tests**

Add `src/server/app.test.ts` with tests that import `createServerApp` and verify:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServerApp } from "./app.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

async function app() {
  const instance = await createServerApp({
    adminPassword: "test-password",
    disableBackgroundJobs: true,
  });
  apps.push(instance);
  return instance;
}

describe("server app routes", () => {
  it("serves health without auth", async () => {
    const server = await app();
    const res = await server.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "9router-key-manager" });
  });

  it("rejects protected routes without auth", async () => {
    const server = await app();
    const res = await server.inject({ method: "GET", url: "/api/keys/usage" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  it("sets signed admin session cookie on login", async () => {
    const server = await app();
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toEqual(
      expect.stringContaining("admin_session="),
    );
  });
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- src/server/app.test.ts`

Expected: fail because `src/server/app.ts` and `createServerApp` do not exist.

- [ ] **Step 3: Implement app factory with no behavior changes**

Move current app construction from `src/server/index.ts` into `createServerApp(options)`.

Required shape:

```ts
export type ServerAppOptions = {
  adminPassword?: string;
  sessionSecret?: string;
  disableBackgroundJobs?: boolean;
};

export async function createServerApp(options: ServerAppOptions = {}) {
  // Existing Fastify setup and route registration.
  // Do not call app.listen() here.
  return app;
}
```

`src/server/index.ts` must import dotenv, call `createServerApp()`, start the listener, and preserve the existing default env behavior.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/server/app.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 2: Shared Policy And Usage Projection

**Files:**

- Create: `src/server/services/policyUsage.ts`
- Create: `src/server/services/policyUsage.test.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/services/watcher.ts`

- [ ] **Step 1: Write failing shared projection tests**

Add tests covering:

- `usageImportSince()` returns `undefined` when no stored timestamp exists.
- `usageImportSince()` returns latest timestamp minus overlap.
- `usageFiltersForPolicies()` maps each API key to its policy `window_start`.
- `resolvedPolicies()` applies `resolveWindow()` and attaches multiplier events.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- src/server/services/policyUsage.test.ts`

Expected: fail because `policyUsage.ts` does not exist.

- [ ] **Step 3: Extract duplicated helpers**

Move logic duplicated between app usage response and watcher into `policyUsage.ts`:

- `resolvedPolicies(db, options?)`
- `usageImportSince(db, overlapMs)`
- `usageFiltersForPolicies(keys, policies)`

Preserve image daily usage behavior in the app path by allowing an optional image usage resolver.

- [ ] **Step 4: Wire app and watcher to shared helpers**

Use the new helpers from both `createServerApp()` and `runWatcherOnce()`.

- [ ] **Step 5: Verify phase**

Run:

```bash
npm test -- src/server/services/policyUsage.test.ts src/server/services/watcher.test.ts src/server/app.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 3: Public Image Services And Routes

**Files:**

- Create: `src/server/services/publicImageStore.ts`
- Create: `src/server/services/publicImageJobs.ts`
- Create: `src/server/routes/publicImages.ts`
- Create: `src/server/services/publicImageJobs.test.ts`
- Modify: `src/server/app.ts`
- Modify: `docs/public-image-creator.md`

- [ ] **Step 1: Write failing queue service tests**

Test `createPublicImageJobQueue()` behavior:

- creates queued jobs with public status shape;
- enforces global and per-key running limits;
- cancels queued jobs and refuses cancellation after running;
- expires completed jobs after TTL cleanup.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- src/server/services/publicImageJobs.test.ts`

Expected: fail because the queue service does not exist.

- [ ] **Step 3: Extract queue service**

Move `ImageJob`, `imageJobs`, `imageQueue`, `scheduleImageJobs()`, `createImageJob()`,
`waitForImageJob()`, cancellation, and public status shaping out of `app.ts`.

- [ ] **Step 4: Extract image storage helpers**

Move image usage summary, daily quota, usage recording, public image save,
history, download lookup, and expired-file cleanup into `publicImageStore.ts`.

- [ ] **Step 5: Register public image routes from a route module**

Move public image endpoint handlers into `routes/publicImages.ts` while keeping
the same URLs, payloads, and errors.

- [ ] **Step 6: Update public image docs**

Update `docs/public-image-creator.md` to list job/status/cancel/history/download
as current primary flow and mark `/generate` as synchronous compatibility.

- [ ] **Step 7: Verify phase**

Run:

```bash
npm test -- src/server/services/publicImageJobs.test.ts src/server/app.test.ts src/server/services/publicImage.test.ts src/server/services/imageProxy.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 4: Admin Route Cleanup

**Files:**

- Create: `src/server/routes/admin.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add admin route characterization tests**

Extend `src/server/app.test.ts` to verify:

- unauthenticated admin config route returns 401;
- authenticated `/api/client-rate-limit/config` returns default config;
- authenticated `/api/model-rate-limit/config` returns default config.

- [ ] **Step 2: Verify RED if missing auth helper/export is needed**

Run: `npm test -- src/server/app.test.ts`

Expected: either pass against current inline routes or fail because the test app
does not yet provide an auth helper. If it passes, keep it as characterization
before extraction.

- [ ] **Step 3: Extract admin route registration**

Move protected admin route registration into `routes/admin.ts`. Keep the same
auth hook and route handlers.

- [ ] **Step 4: Update README endpoint inventory**

Update the current endpoint list to include admin config, traffic, image usage,
public image job, history, and download endpoints.

- [ ] **Step 5: Verify phase**

Run:

```bash
npm test -- src/server/app.test.ts src/client/api.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 5: Proxy Route Extraction

**Files:**

- Create: `src/server/routes/proxy.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/app.test.ts`
- Modify: `docs/ops/9router-traffic-timeouts.md`

- [ ] **Step 1: Add proxy route characterization tests**

Add tests around current behavior that can run with injected dependencies:

- missing or unknown bearer token still reaches proxy path unless blocked by upstream;
- expired key interceptor returns the existing expired-key body;
- client rate limit rejection returns 429 and `retry-after`;
- image direct proxy route sets `x-image-proxy: direct`.

- [ ] **Step 2: Run focused tests and verify RED only where dependency injection is missing**

Run: `npm test -- src/server/app.test.ts`

Expected: tests may fail until `createServerApp()` supports injected fetch/upstream
dependencies.

- [ ] **Step 3: Add minimal dependency injection**

Allow `createServerApp()` to accept dependency overrides needed by route tests:

- `fetchImpl`
- `db`
- `readApiKeys`
- `readUsageHistorySince`
- background job disable flag

Keep production defaults identical.

- [ ] **Step 4: Extract proxy registration**

Move `/v1/*` parser and handler into `routes/proxy.ts`. Preserve route order and
lease-release behavior.

- [ ] **Step 5: Update traffic docs if pipeline wording changed**

Keep docs aligned with the actual order of interceptors and limiters.

- [ ] **Step 6: Verify phase**

Run:

```bash
npm test -- src/server/app.test.ts src/server/services/proxyFailover.test.ts src/server/services/quotaInterceptor.test.ts src/server/services/keyAccessInterceptor.test.ts src/server/services/clientRateLimiter.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 6: Frontend Contract Cleanup And Docs Reconciliation

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/client/ImageCreator.tsx`
- Modify: `src/client/Dashboard.tsx`
- Modify: `README.md`
- Modify: `docs/public-image-creator.md`

- [ ] **Step 1: Add shared public image API types**

Move local public image response types from `ImageCreator.tsx` into
`src/shared/types.ts` only if doing so reduces duplication and does not expand
runtime scope.

- [ ] **Step 2: Verify frontend type usage**

Run: `./node_modules/.bin/tsc --noEmit`

Expected: pass.

- [ ] **Step 3: Reconcile docs**

Ensure README and public image docs match:

- current endpoint inventory;
- current data source order;
- current queued image flow;
- warning that historical specs/plans require verification.

- [ ] **Step 4: Verify phase**

Run:

```bash
npm test -- src/client/api.test.ts src/client/adminTabs.test.ts src/client/format.test.ts
./node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: all pass.

## Task 7: Final Verification And Review

**Files:**

- Review all changed files.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run lint
npm run build
```

Expected: all pass.

- [ ] **Step 2: Inspect diff**

Run:

```bash
git diff --stat main
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 3: Summarize behavior preservation evidence**

Prepare final notes covering:

- route tests added;
- service tests added;
- full verification output;
- docs updated;
- any intentional non-changes or deferred risks.
