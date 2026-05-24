# GoCinema Client Telegram Bot Design

## Goal

Build `GoCinema Assistant` as the main Telegram bot for GoCinema clients. The first release replaces the public `/check` quota flow with a conversational bot, while keeping the menu and command structure ready for future client modules.

## Bot Identity

- Display name: `GoCinema Assistant`
- Username: `@gocinema_assistant_bot`

## Scope

This release includes:

- Telegram long-polling worker as a separate service in this repo.
- Main client menu with extensible modules.
- Slash commands registered with Telegram so users see suggestions when typing `/`.
- One saved API key per Telegram user.
- Manual quota checks using the existing key-manager public API.
- Quota check history.
- Opt-in quota alerts with threshold settings.
- A background alert loop.
- Conversation cancel/reset command.

Out of scope:

- Admin broadcast.
- Payment or billing management.
- Support tickets.
- Multiple keys per Telegram user.

## Architecture

The bot runs as a separate TypeScript entrypoint in the same package. It uses Telegram Bot API long polling, stores user state in the existing key-manager SQLite database, and calls the local key-manager public API (`POST /api/public/key-check`) for quota data. This keeps quota behavior aligned with `https://user.gocinema.io.vn/check` and avoids duplicating quota policy logic in the bot.

The service can be deployed separately from the web/API service with systemd:

- `9router-key-manager` continues serving admin, public UI, and public API.
- `gocinema-assistant-bot` runs the Telegram worker.

## User Experience

Main menu:

- `📊 Quota`
- `🔑 Key`
- `🔔 Thông báo`
- `📜 Lịch sử`
- `⚙️ Cài đặt`
- `❓ Trợ giúp`

Slash commands:

- `/start`
- `/quota`
- `/check`
- `/refresh`
- `/key`
- `/key_change`
- `/alerts_on`
- `/alerts_off`
- `/threshold_20`
- `/threshold_10`
- `/threshold_5`
- `/threshold_custom`
- `/history`
- `/settings`
- `/cancel`
- `/help`

The menu is module-oriented: quota, key, alerts, history, settings, and help are independent handlers. Future modules can be added by registering a new menu item and command handler without changing existing quota flows.

## Data Model

New tables live in the manager SQLite database:

- `bot_users`: Telegram identity, chat id, saved key, masked key, timestamps.
- `bot_user_settings`: alert opt-in and threshold.
- `bot_user_states`: pending key or threshold input.
- `bot_quota_checks`: recent manual and background checks.
- `bot_quota_alerts`: duplicate prevention for proactive alerts.

API keys are stored in plain text so the bot can check quota and send alerts. The SQLite database must remain protected by filesystem permissions.

## Error Handling

- Missing Telegram token fails startup with a clear error.
- Missing saved key guides the user to `/key_change`.
- Public API 404/401 errors are shown as invalid or unknown key messages.
- Network/API errors are logged and shown only for manual checks.
- Background alert errors are logged and recorded but not sent to users.
- `/cancel` resets pending conversation state without deleting the saved key.

## Testing

Unit tests cover formatting, database migrations, command registration, routing, key flow, quota checks, cancel behavior, history, settings, and alert duplicate prevention.

## Deployment

Configuration is environment-driven:

- `TELEGRAM_BOT_TOKEN`
- `BOT_PUBLIC_API_BASE_URL`
- `BOT_POLL_TIMEOUT_SECONDS`
- `BOT_REQUEST_TIMEOUT_SECONDS`
- `BOT_COOLDOWN_SECONDS`
- `BOT_ALERT_CHECK_INTERVAL_SECONDS`
- `BOT_ALERT_BATCH_LIMIT`
- `BOT_DEFAULT_ALERT_THRESHOLD_PERCENT`
- `BOT_TIMEZONE_OFFSET_HOURS`

The systemd example file documents running the bot as a separate service.
