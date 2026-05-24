import 'dotenv/config';
import { openDb } from '../server/db/index.js';
import { AlertEngine } from './alerts.js';
import { GoCinemaAssistantBot } from './bot.js';
import { KeyManagerPublicApi } from './clientApi.js';
import { readBotConfig } from './config.js';
import { BotDatabase, migrateBotDatabase } from './database.js';
import { BOT_COMMANDS, TelegramClient } from './telegram.js';

const config = readBotConfig();
const sqlite = openDb();
migrateBotDatabase(sqlite);

const db = new BotDatabase(sqlite, { defaultAlertThresholdPercent: config.defaultAlertThresholdPercent });
const telegram = new TelegramClient({ token: config.telegramBotToken });
const api = new KeyManagerPublicApi({ baseUrl: config.publicApiBaseUrl, timeoutMs: config.requestTimeoutMs });
const bot = new GoCinemaAssistantBot({ db, telegram, api, timezoneOffsetHours: config.timezoneOffsetHours });
const alerts = new AlertEngine({ db, telegram, api, timezoneOffsetHours: config.timezoneOffsetHours, batchLimit: config.alertBatchLimit });

let running = true;
let nextOffset: number | undefined;
let alertRunning = false;

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

await telegram.setMyCommands(BOT_COMMANDS);
console.log('GoCinema Assistant bot started');

let nextAlertAt = 0;
while (running) {
  const now = Date.now();
  if (now >= nextAlertAt && !alertRunning) {
    nextAlertAt = now + config.alertCheckIntervalMs;
    alertRunning = true;
    alerts.runOnce()
      .catch(error => console.error('alert loop failed', error))
      .finally(() => { alertRunning = false; });
  }

  try {
    const updates = await telegram.getUpdates({ offset: nextOffset, timeoutSeconds: config.pollTimeoutSeconds });
    for (const update of updates) {
      nextOffset = update.update_id + 1;
      await bot.handleUpdate(update);
    }
  } catch (error) {
    console.error('telegram polling failed', error);
    await sleep(2000);
  }
}

sqlite.close();
console.log('GoCinema Assistant bot stopped');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
