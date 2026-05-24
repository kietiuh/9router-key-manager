import type { KeyUsageSummary } from '../shared/types.js';
import { commandForAction } from './actions.js';
import { PublicApiError } from './clientApi.js';
import type { BotDatabase, BotUserIdentity } from './database.js';
import {
  cancelMarkup,
  formatHelpText,
  formatHistoryText,
  formatHomeText,
  formatKeyText,
  formatQuotaMessage,
  formatSettingsText,
  formatUnknownText,
  historyMarkup,
  homeMarkup,
  keyMarkup,
  noKeyMarkup,
  noKeyText,
  quotaMarkup,
  settingsMarkup,
} from './formatting.js';
import { commandForMenuText } from './telegram.js';
import type { TelegramUpdate } from './telegram.js';

type RenderTarget = {
  chatId: number;
  messageId?: number;
};

type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type CallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

export type TelegramSender = {
  sendMessage(chatId: number, text: string, options?: Record<string, unknown>): Promise<void>;
  editMessageText?(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, options?: Record<string, unknown>): Promise<void>;
};

export type KeyChecker = {
  checkKey(apiKey: string): Promise<KeyUsageSummary>;
};

export class GoCinemaAssistantBot {
  constructor(
    private readonly deps: {
      db: BotDatabase;
      telegram: TelegramSender;
      api: KeyChecker;
      timezoneOffsetHours: number;
    },
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const rawText = message?.text?.trim();
    if (!chatId || !telegramUserId || !rawText) return;

    const identity = identityFromUser(message.from);
    this.deps.db.saveUserIdentity(identity, chatId);

    const menuCommand = commandForMenuText(rawText);
    const text = menuCommand ?? rawText;
    const command = normalizeCommand(text);
    const state = this.deps.db.getUserState(telegramUserId);
    if (state === 'awaiting_key' && !command) {
      await this.handleIncomingKey(identity, chatId, rawText);
      return;
    }
    if (state === 'awaiting_threshold' && !command) {
      await this.handleIncomingThreshold(telegramUserId, { chatId }, rawText);
      return;
    }

    await this.handleCommand({
      command,
      text,
      telegramUserId,
      target: { chatId },
    });
  }

  private async handleCallback(callback: CallbackQuery): Promise<void> {
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const telegramUserId = callback.from?.id;
    const command = callback.data ? commandForAction(callback.data) : null;
    if (!chatId || !telegramUserId || !messageId || !command) {
      await this.answerCallback(callback.id, 'Thao tác này không còn hợp lệ.');
      return;
    }

    const identity = identityFromUser(callback.from);
    this.deps.db.saveUserIdentity(identity, chatId);
    await this.answerCallback(callback.id);

    try {
      await this.handleCommand({
        command,
        text: command,
        telegramUserId,
        target: { chatId, messageId },
      });
    } catch (error) {
      await this.render({ chatId, messageId }, `Không xử lý được thao tác: ${userErrorMessage(error)}`, homeMarkup());
      throw error;
    }
  }

  private async handleCommand(args: {
    command: string | null;
    text: string;
    telegramUserId: number;
    target: RenderTarget;
  }): Promise<void> {
    switch (args.command ?? args.text) {
      case '/start':
        await this.handleStart(args.telegramUserId, args.target);
        break;
      case '/quota':
      case '/check':
      case '/refresh':
        await this.handleQuota(args.telegramUserId, args.target);
        break;
      case '/key':
        await this.handleKey(args.telegramUserId, args.target);
        break;
      case '/key_change':
        this.deps.db.setUserState(args.telegramUserId, 'awaiting_key');
        await this.render(args.target, 'Gửi GoCinema API key mới trong tin nhắn tiếp theo.\nDùng /cancel hoặc bấm Hủy thao tác để dừng.', cancelMarkup());
        break;
      case '/history':
        await this.render(
          args.target,
          formatHistoryText(this.deps.db.recentQuotaChecks(args.telegramUserId, 5), this.deps.timezoneOffsetHours),
          historyMarkup(),
        );
        break;
      case '/settings':
        await this.handleSettings(args.telegramUserId, args.target);
        break;
      case '/alerts_on':
        this.deps.db.setAlertSettings(args.telegramUserId, true);
        await this.handleSettings(args.telegramUserId, args.target);
        break;
      case '/alerts_off':
        this.deps.db.setAlertSettings(args.telegramUserId, false);
        await this.handleSettings(args.telegramUserId, args.target);
        break;
      case '/threshold_20':
        await this.handleThreshold(args.telegramUserId, args.target, 20);
        break;
      case '/threshold_10':
        await this.handleThreshold(args.telegramUserId, args.target, 10);
        break;
      case '/threshold_5':
        await this.handleThreshold(args.telegramUserId, args.target, 5);
        break;
      case '/threshold_custom':
        this.deps.db.setUserState(args.telegramUserId, 'awaiting_threshold');
        await this.render(args.target, 'Gửi ngưỡng cảnh báo quota từ 1 đến 100 trong tin nhắn tiếp theo.\nDùng /cancel hoặc bấm Hủy thao tác để dừng.', cancelMarkup());
        break;
      case '/cancel':
        this.deps.db.clearUserState(args.telegramUserId);
        await this.render(args.target, 'Đã hủy thao tác đang nhập.', homeMarkup());
        break;
      case '/help':
        await this.render(args.target, formatHelpText(), homeMarkup());
        break;
      default:
        await this.render(args.target, args.command ? formatHelpText() : formatUnknownText(), homeMarkup());
        break;
    }
  }

  private async handleStart(telegramUserId: number, target: RenderTarget): Promise<void> {
    const user = this.deps.db.getUser(telegramUserId);
    if (user?.apiKey) {
      await this.handleQuota(telegramUserId, target);
      return;
    }
    await this.sendMenu(target);
  }

  private async sendMenu(target: RenderTarget): Promise<void> {
    await this.render(target, formatHomeText(), homeMarkup());
  }

  private async handleIncomingKey(identity: BotUserIdentity, chatId: number, apiKey: string): Promise<void> {
    try {
      const summary = await this.deps.api.checkKey(apiKey);
      this.deps.db.saveUserKey(identity, chatId, apiKey, summary.keyMasked);
      this.deps.db.clearUserState(identity.id);
      this.logQuota(identity.id, 'manual', summary);
      const settings = this.deps.db.getSettings(identity.id);
      await this.render({ chatId }, formatQuotaMessage({
        summary,
        alertsEnabled: settings.alertsEnabled,
        alertThresholdPercent: settings.alertThresholdPercent,
        timezoneOffsetHours: this.deps.timezoneOffsetHours,
      }), quotaMarkup());
    } catch (error) {
      const message = userErrorMessage(error);
      this.deps.db.logQuotaCheck({ telegramUserId: identity.id, source: 'manual', success: false, maskedKey: null, error: message });
      await this.render({ chatId }, `Không kiểm tra được key: ${message}\nGửi key khác hoặc dùng /cancel.`, cancelMarkup());
    }
  }

  private async handleQuota(telegramUserId: number, target: RenderTarget): Promise<void> {
    const user = this.deps.db.getUser(telegramUserId);
    if (!user?.apiKey) {
      await this.render(target, noKeyText(), noKeyMarkup());
      return;
    }
    try {
      const summary = await this.deps.api.checkKey(user.apiKey);
      this.logQuota(telegramUserId, 'manual', summary);
      const settings = this.deps.db.getSettings(telegramUserId);
      await this.render(target, formatQuotaMessage({
        summary,
        alertsEnabled: settings.alertsEnabled,
        alertThresholdPercent: settings.alertThresholdPercent,
        timezoneOffsetHours: this.deps.timezoneOffsetHours,
      }), quotaMarkup());
    } catch (error) {
      const message = userErrorMessage(error);
      this.deps.db.logQuotaCheck({ telegramUserId, source: 'manual', success: false, maskedKey: user.keyMasked, error: message });
      await this.render(target, `Không kiểm tra được quota: ${message}`, quotaMarkup());
    }
  }

  private async handleKey(telegramUserId: number, target: RenderTarget): Promise<void> {
    const user = this.deps.db.getUser(telegramUserId);
    await this.render(target, formatKeyText({ keyMasked: user?.keyMasked }), user?.keyMasked ? keyMarkup() : noKeyMarkup());
  }

  private async handleSettings(telegramUserId: number, target: RenderTarget): Promise<void> {
    const settings = this.deps.db.getSettings(telegramUserId);
    await this.render(target, formatSettingsText(settings), settingsMarkup(settings));
  }

  private async handleThreshold(telegramUserId: number, target: RenderTarget, thresholdPercent: number): Promise<void> {
    const current = this.deps.db.getSettings(telegramUserId);
    this.deps.db.setAlertSettings(telegramUserId, current.alertsEnabled, thresholdPercent);
    await this.handleSettings(telegramUserId, target);
  }

  private async handleIncomingThreshold(telegramUserId: number, target: RenderTarget, rawThreshold: string): Promise<void> {
    const thresholdPercent = Number(rawThreshold);
    if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) {
      await this.render(target, 'Ngưỡng phải là số nguyên từ 1 đến 100. Gửi lại hoặc dùng /cancel.', cancelMarkup());
      return;
    }
    const current = this.deps.db.getSettings(telegramUserId);
    this.deps.db.setAlertSettings(telegramUserId, current.alertsEnabled, thresholdPercent);
    this.deps.db.clearUserState(telegramUserId);
    await this.handleSettings(telegramUserId, target);
  }

  private async render(target: RenderTarget, text: string, replyMarkup: Record<string, unknown>): Promise<void> {
    const options = { reply_markup: replyMarkup };
    if (target.messageId && this.deps.telegram.editMessageText) {
      await this.deps.telegram.editMessageText(target.chatId, target.messageId, text, options);
      return;
    }
    await this.deps.telegram.sendMessage(target.chatId, text, options);
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.deps.telegram.answerCallbackQuery) return;
    if (text) {
      await this.deps.telegram.answerCallbackQuery(callbackQueryId, { text });
      return;
    }
    await this.deps.telegram.answerCallbackQuery(callbackQueryId);
  }

  private logQuota(telegramUserId: number, source: 'manual' | 'alert', summary: KeyUsageSummary): void {
    this.deps.db.logQuotaCheck({
      telegramUserId,
      source,
      success: true,
      maskedKey: summary.keyMasked,
      status: summary.status,
      total: summary.total,
      tokenLimit: summary.tokenLimit,
      percentOfLimit: summary.percentOfLimit,
      resetAt: summary.windowEnd ?? null,
    });
  }
}

function identityFromUser(from: TelegramUser | undefined): BotUserIdentity {
  return {
    id: Number(from?.id),
    username: from?.username ?? null,
    firstName: from?.first_name ?? null,
    lastName: from?.last_name ?? null,
  };
}

function normalizeCommand(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const first = text.split(/\s+/, 1)[0].toLowerCase();
  const [command] = first.split('@', 1);
  return command;
}

function userErrorMessage(error: unknown): string {
  if (error instanceof PublicApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
