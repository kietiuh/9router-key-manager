# GoCinema Client Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the GoCinema Assistant Telegram bot worker with quota checks, key management, alerts, history, cancel/reset, docs, and deployment scaffolding.

**Architecture:** Add a separate TypeScript bot entrypoint under `src/bot`. The bot uses Telegram long polling, stores state in the existing manager SQLite database, and checks quota through `POST /api/public/key-check` on the local key-manager API. This keeps quota semantics identical to the current public `/check` page while allowing the bot service to restart independently.

**Tech Stack:** TypeScript, Node fetch, better-sqlite3, Vitest, Telegram Bot API long polling, systemd.

---

## File Structure

- Create `src/bot/config.ts`: environment parsing and bot config defaults.
- Create `src/bot/telegram.ts`: small Telegram Bot API client and command list.
- Create `src/bot/database.ts`: SQLite migrations and bot persistence helpers.
- Create `src/bot/clientApi.ts`: key-manager public API client.
- Create `src/bot/formatting.ts`: user-facing text and Telegram keyboard markup.
- Create `src/bot/alerts.ts`: alert threshold and duplicate-send decisions.
- Create `src/bot/bot.ts`: update routing, menu handlers, key/settings/history flows.
- Create `src/bot/index.ts`: runtime entrypoint for polling and alert loop.
- Add tests next to these modules under `src/bot/*.test.ts`.
- Modify `package.json`, `.env.example`, `README.md`.
- Create `deploy/systemd/gocinema-assistant-bot.service.example`.

## Tasks

### Task 1: Formatting And Commands

- [x] Write failing tests for menu markup, command list, quota dashboard text, help text, and cancel text.
- [x] Implement `src/bot/formatting.ts` and command metadata in `src/bot/telegram.ts`.
- [x] Run `npm test -- src/bot/formatting.test.ts src/bot/telegram.test.ts`.

### Task 2: Database

- [x] Write failing tests for idempotent migrations, default settings, saved key flow, pending state, history rows, and alert duplicate tracking.
- [x] Implement `src/bot/database.ts`.
- [x] Run `npm test -- src/bot/database.test.ts`.

### Task 3: Public API Client

- [x] Write failing tests for successful key check parsing, not-found errors, and upstream network errors.
- [x] Implement `src/bot/clientApi.ts`.
- [x] Run `npm test -- src/bot/clientApi.test.ts`.

### Task 4: Bot Routing

- [x] Write failing tests for `/start`, no-key quota guidance, key replacement, `/cancel`, `/history`, `/settings`, alert toggles, and command aliases.
- [x] Implement `src/bot/bot.ts`.
- [x] Run `npm test -- src/bot/bot.test.ts`.

### Task 5: Background Alerts

- [x] Write failing tests for skipped disabled users, threshold alert, duplicate prevention, and alert reset-window behavior.
- [x] Implement `src/bot/alerts.ts`.
- [x] Run `npm test -- src/bot/alerts.test.ts`.

### Task 6: Runtime And Deployment Docs

- [x] Write the runtime entrypoint in `src/bot/index.ts`.
- [x] Add package scripts for bot startup.
- [x] Update `.env.example`, `README.md`, and systemd example.
- [x] Run `npm test`, `./node_modules/.bin/tsc --noEmit`, `npm run lint`, and `npm run build`.
