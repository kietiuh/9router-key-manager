# Multi Final Fallback Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Support multiple ordered final fallback models without rotation or sticky state.

**Architecture:** Extend the existing final fallback config contract to include `models: string[]` while retaining legacy `model`. The proxy attempt list appends each configured final fallback model in order and treats final fallback upstream, proxy, timeout, and local rate queue failures as retryable until the last configured fallback.

**Tech Stack:** TypeScript, Fastify, React, better-sqlite3, Vitest, Zod.

---

### Task 1: Shared Config Contract

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/finalFallback.ts`
- Test: `src/shared/finalFallback.test.ts`

- [x] Write tests proving whitespace trimming, deduplication, `model` as first model, and enabled validation for `models`.
- [x] Run `npx vitest run src/shared/finalFallback.test.ts` and confirm the new tests fail because `models` is not supported.
- [x] Add `models: string[]` to `FinalFallbackConfig`, normalize `model` plus `models`, and update `finalFallbackNeedsModel`.
- [x] Run `npx vitest run src/shared/finalFallback.test.ts` and confirm it passes.

### Task 2: Server Config Persistence And API Validation

**Files:**
- Modify: `src/server/services/finalFallback.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/services/finalFallback.test.ts`

- [x] Write tests for legacy `final_fallback_model` migration into `models`, JSON source-of-truth behavior, and saving `final_fallback_models_json`.
- [x] Run `npx vitest run src/server/services/finalFallback.test.ts` and confirm the new tests fail.
- [x] Read `final_fallback_models_json` when present, fall back to `final_fallback_model`, and save both keys.
- [x] Update `FinalFallbackConfigBody` to accept optional `models`.
- [x] Run `npx vitest run src/server/services/finalFallback.test.ts`.

### Task 3: Proxy Failover Attempt Ordering

**Files:**
- Modify: `src/server/services/proxyFailover.ts`
- Test: `src/server/services/proxyFailover.test.ts`

- [x] Write tests for attempts `source -> A -> B`, retrying final fallback `400` and local rate queue rejection to the next fallback, masking the last fallback failure, deduping fallback models, and request reset behavior.
- [x] Run `npx vitest run src/server/services/proxyFailover.test.ts` and confirm the new tests fail.
- [x] Update `appendFallback` and retry handling so final fallback retries every HTTP `>=400` while another final fallback remains.
- [x] Run `npx vitest run src/server/services/proxyFailover.test.ts`.

### Task 4: Admin UI

**Files:**
- Modify: `src/client/AdminRouting.tsx`
- Modify: `src/client/style.css`

- [x] Update `FinalFallbackPanel` to edit ordered fallback models with add/remove/up/down controls.
- [x] Keep validation aligned with `finalFallbackNeedsModel`.
- [x] Confirm TypeScript build catches the updated config contract.

### Task 5: Full Verification

**Files:**
- All touched files

- [x] Run focused tests:
  - `npx vitest run src/shared/finalFallback.test.ts src/server/services/finalFallback.test.ts src/server/services/proxyFailover.test.ts`
- [x] Run full repo verification:
  - `npm test`
  - `./node_modules/.bin/tsc --noEmit`
  - `npm run build`
  - `npm run lint`
- [x] Review `git diff` for scope and ensure no unrelated changes were introduced.
