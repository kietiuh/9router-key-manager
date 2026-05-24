# Watcher-Driven Bot Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move proactive Telegram quota alerts from per-user API polling to watcher-generated alert jobs and bot-side delivery.

**Architecture:** The server watcher already computes quota summaries from local usage and policy state every minute. It will enqueue per-user alert jobs for subscribed users whose saved key crosses their threshold, using the same alert category semantics as the bot. The Telegram bot will stop rechecking every user through `/api/public/key-check` in the background and will instead deliver pending jobs in bounded batches with existing duplicate prevention.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, systemd service deployment.

---

### Task 1: Alert Queue Schema And Bot Database API

**Files:**
- Modify: `src/bot/database.ts`
- Test: `src/bot/alerts.test.ts`

- [ ] **Step 1: Write failing delivery test**

Add a test that inserts a pending alert job and expects `AlertEngine.runOnce()` to send one Telegram message, record `bot_quota_alerts`, and mark the job sent.

Run: `npm test -- src/bot/alerts.test.ts`
Expected: FAIL because pending alert job methods do not exist and `AlertEngine` still polls the public API.

- [ ] **Step 2: Implement queue table and methods**

Add `bot_alert_jobs` to `migrateBotDatabase()` with `status`, `attempts`, `summary_json`, and a unique key on `(telegram_user_id, key_fingerprint, reset_at, threshold_percent, category)`.

Add `enqueueAlertJob()`, `pendingAlertJobs()`, `markAlertJobSent()`, and `markAlertJobFailed()` to `BotDatabase`.

- [ ] **Step 3: Refactor `AlertEngine` to deliver queued jobs**

Change `AlertEngine.runOnce()` to read pending jobs, format the stored summary, send Telegram, call `recordAlertSent()`, and mark the job sent. Preserve duplicate suppression by checking `hasSentAlert()` before sending.

- [ ] **Step 4: Verify bot alert tests**

Run: `npm test -- src/bot/alerts.test.ts src/bot/database.test.ts`
Expected: PASS.

### Task 2: Shared Alert Classification

**Files:**
- Create: `src/shared/quotaAlerts.ts`
- Modify: `src/bot/alerts.ts`
- Test: `src/bot/alerts.test.ts`

- [ ] **Step 1: Write failing import/use test**

Update alert tests to import `alertCategory()` and `keyFingerprint()` through the bot module while implementation delegates to shared code.

Run: `npm test -- src/bot/alerts.test.ts`
Expected: FAIL until the shared module exists and the bot re-exports the functions.

- [ ] **Step 2: Implement shared helpers**

Move alert category and key fingerprint logic into `src/shared/quotaAlerts.ts`, then re-export from `src/bot/alerts.ts` so existing callers keep working.

- [ ] **Step 3: Verify helper tests**

Run: `npm test -- src/bot/alerts.test.ts`
Expected: PASS.

### Task 3: Watcher Enqueue Path

**Files:**
- Create: `src/server/services/botAlertQueue.ts`
- Create: `src/server/services/botAlertQueue.test.ts`
- Modify: `src/server/services/watcher.ts`
- Modify: `src/server/services/watcher.test.ts`
- Modify: `src/server/db/schema.ts`

- [ ] **Step 1: Write failing queue service test**

Add a test that creates one subscribed bot user with threshold `40`, passes a summary at `60%` used, and expects one `bot_alert_jobs` row with category `token_low`.

Run: `npm test -- src/server/services/botAlertQueue.test.ts`
Expected: FAIL because `enqueueBotQuotaAlertJobs()` does not exist.

- [ ] **Step 2: Implement queue service**

Create `enqueueBotQuotaAlertJobs(db, summaries, keys)` that skips when bot tables are missing, maps summaries to real API keys, computes each subscribed user's alert category, checks `bot_quota_alerts`, and inserts pending jobs with `INSERT OR IGNORE`.

- [ ] **Step 3: Write failing watcher integration test**

Extend watcher tests so `runWatcherOnce()` imports usage, computes a summary, and enqueues one alert job for a subscribed user.

Run: `npm test -- src/server/services/watcher.test.ts`
Expected: FAIL until watcher calls the queue service.

- [ ] **Step 4: Wire watcher to queue service**

Call `enqueueBotQuotaAlertJobs()` after summaries are computed and before hard-disable actions mutate upstream key state. Include the returned count in the watcher result for observability.

- [ ] **Step 5: Verify server tests**

Run: `npm test -- src/server/services/botAlertQueue.test.ts src/server/services/watcher.test.ts`
Expected: PASS.

### Task 4: Runtime Docs

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update docs**

Document that proactive alerts are watcher-driven and `BOT_ALERT_CHECK_INTERVAL_SECONDS` now controls delivery queue scans, not quota recomputation.

- [ ] **Step 2: Verify docs do not mention stale behavior**

Run: `rg -n "background quota alert scan interval|per-user.*check" README.md .env.example docs/superpowers/specs/2026-05-24-gocinema-client-telegram-bot-design.md`
Expected: no stale production-facing wording in `README.md`, `.env.example`, or the bot design spec.

### Task 5: Full Verification, PR, Merge, Deploy

**Files:**
- All touched files.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- src/bot/alerts.test.ts src/bot/database.test.ts src/server/services/botAlertQueue.test.ts src/server/services/watcher.test.ts`
Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `npm test`
Run: `./node_modules/.bin/tsc --noEmit`
Run: `npm run build`
Run: `npm run lint`
Expected: all commands exit 0.

- [ ] **Step 3: Commit and open PR**

Commit the branch and create a GitHub PR with summary and tests.

- [ ] **Step 4: Merge and deploy**

Merge to `main`, restart `9router-key-manager.service` and `gocinema-assistant-bot.service`, then verify service health and API health.

- [ ] **Step 5: Live smoke check**

Confirm `bot_alert_jobs` exists in the production manager DB and the bot service is active.
