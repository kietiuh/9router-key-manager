# Model Rewrite Target Weights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each model rewrite target to define its own sticky request count, so `A -> B:1, C:2, D:3` rotates as `B, C, C, D, D, D`.

**Architecture:** Store target weights alongside `to_models_json`, keep existing `sticky_count` as the legacy/default weight, and continue using `sticky_index` plus `sticky_used` as rule state. Failover still tries each unique target once from the selected target onward.

**Tech Stack:** TypeScript, Fastify, Zod, React, better-sqlite3, Vitest.

---

### Task 1: Service Model And Persistence

**Files:**
- Modify: `src/server/services/modelRewrite.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/shared/types.ts`
- Test: `src/server/services/modelRewrite.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that save `{ fromModel: 'source', toModels: ['B', 'C', 'D'], targetWeights: [1, 2, 3] }`, assert returned config includes `targetWeights: [1, 2, 3]`, and assert repeated selections return `B, C, C, D, D, D, B`.

- [ ] **Step 2: Verify red**

Run: `npm test -- src/server/services/modelRewrite.test.ts`

Expected: fail because `targetWeights` is not supported.

- [ ] **Step 3: Implement minimal service/schema support**

Add `target_weights_json` migration, normalize weights to one positive integer per target, map legacy configs to `stickyCount` per target, persist JSON weights, and change selection/rollback to use the selected target's weight.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/server/services/modelRewrite.test.ts`

Expected: pass.

### Task 2: API And UI

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/client/AdminRouting.tsx`
- Modify: `src/client/style.css`
- Test: existing build/type checks

- [ ] **Step 1: Extend request validation**

Allow `targetWeights?: number[]` on model rewrite rule payloads.

- [ ] **Step 2: Update admin draft state**

Track `targetWeights` beside `toModels`; add/remove/reorder lengths together; include weights in save payload.

- [ ] **Step 3: Update admin controls**

Render each target row with a model input and a positive integer `Lượt` field.

- [ ] **Step 4: Verify compile**

Run: `./node_modules/.bin/tsc --noEmit`

Expected: pass.

### Task 3: End-To-End Verification

**Files:**
- All changed files

- [ ] **Step 1: Run focused tests**

Run: `npm test -- src/server/services/modelRewrite.test.ts src/server/services/modelRewriteProxy.test.ts src/server/services/proxyFailover.test.ts`

Expected: pass.

- [ ] **Step 2: Run full test stack**

Run: `npm test`

Expected: pass.

- [ ] **Step 3: Run compile/build/lint**

Run: `./node_modules/.bin/tsc --noEmit`
Run: `npm run build`
Run: `npm run lint`

Expected: all pass.

- [ ] **Step 4: Review and ship**

Run: `git diff --check`, inspect `git diff`, commit the branch, create PR, inspect PR diff/checks, then report whether merge/deploy was performed.
