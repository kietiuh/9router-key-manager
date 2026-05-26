# 9router Scale Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the current single-VPS 9router/key-manager deployment for more clients without prematurely moving off SQLite.

**Architecture:** Keep the current single-node proxy/control-plane shape. Reduce hot-path DB reads, stop avoidable usage-history duplication, make storage cleanup repeatable, and move host hardening into documented systemd/journald steps.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, systemd, Caddy.

---

### Task 1: Usage Ingest Dedupe

**Files:**
- Modify: `src/server/services/usageStore.ts`
- Modify: `src/server/services/usageStore.test.ts`

- [x] Add a failing test proving usage records with the same logical request but different `cost` produce the same signature.
- [x] Remove `cost` from `usageSignature()` so ingest uniqueness matches quota summarization.
- [x] Run `npm test -- src/server/services/usageStore.test.ts`.

### Task 2: Request-Time Key Cache

**Files:**
- Create: `src/server/services/apiKeyCache.ts`
- Create: `src/server/services/apiKeyCache.test.ts`
- Modify: `src/server/index.ts`

- [x] Add failing tests for cache hit, TTL refresh, explicit invalidation, and token lookup.
- [x] Add `createApiKeyCache()` with `getKeys()`, `lookup()`, and `invalidate()`.
- [x] Use the cache on public key lookup and `/v1/*` key lookup.
- [x] Invalidate after policy mutations and manual watcher runs.
- [x] Run `npm test -- src/server/services/apiKeyCache.test.ts`.

### Task 3: Lean Success Logging

**Files:**
- Create: `src/server/services/trafficLog.ts`
- Create: `src/server/services/trafficLog.test.ts`
- Modify: `src/server/index.ts`

- [x] Add failing tests proving success logs omit limiter snapshots by default and include them only when enabled.
- [x] Replace inline success log object construction with `buildTrafficLogMeta()`.
- [x] Keep queue rejection and failure logs unchanged.
- [x] Run `npm test -- src/server/services/trafficLog.test.ts`.

### Task 4: Storage Maintenance Command

**Files:**
- Create: `src/server/ops/keyManagerStorageMaintenance.ts`
- Create: `src/server/ops/keyManagerStorageMaintenance.test.ts`
- Create: `scripts/ops/maintain-key-manager-storage.ts`
- Modify: `package.json`

- [x] Add failing tests for duplicate usage cleanup, canonical signature rewrite, dry-run safety, and expired public-image cleanup.
- [x] Implement `analyzeKeyManagerStorage()` and `maintainKeyManagerStorage()`.
- [x] Add a CLI that dry-runs by default, backs up before `--apply`, and supports `--no-vacuum`.
- [x] Run `npm test -- src/server/ops/keyManagerStorageMaintenance.test.ts`.

### Task 5: Runbook

**Files:**
- Create: `docs/ops/9router-scale-hardening.md`
- Modify: `.env.example`
- Modify: `README.md`

- [x] Document local-only listen policy, journald cap, key cache TTL, lean logging, and storage maintenance.
- [x] Add environment variable examples.

### Task 6: Validate, PR, Deploy, Verify

**Files:**
- All changed files.

- [x] Run `npm test`.
- [x] Run `./node_modules/.bin/tsc --noEmit`.
- [x] Run `npm run build`.
- [x] Run `npm run lint`.
- [ ] Commit, push branch, create PR, review diff, merge to `main`.
- [ ] Deploy code, apply systemd/journald hardening, run storage maintenance with backup, restart services, and verify public endpoints.
