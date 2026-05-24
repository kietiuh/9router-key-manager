import type { KeyUsageSummary } from '../shared/types.js';
import { PublicApiError } from './clientApi.js';
import type { BotDatabase, BotUserIdentity } from './database.js';
import {
  clearConversationText,
  formatHelpText,
  formatHistoryText,
  formatKeyText,
  formatQuotaMessage,
  formatSettingsText,
  menuMarkup,
  noKeyText,
} from './formatting.js';
import { commandForMenuText } from './telegram.js';

type TelegramUpdate = {
  message?: {
    message_id?: number;
    chat?: { id?: number };
    from?: { id?: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
  };
};

export type TelegramSender = {
  sendMessage(chatId: number, text: string, options?: Record<string, unknown>): Promise<void>;
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
    const message = update.message;
    const chatId = message?.chat?.id;
    const telegramUserId = message?.from?.id;
    const rawText = message?.text?.trim();
    if (!chatId || !telegramUserId || !rawText) return;

    const identity = identityFromMessage(message.from);
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
      await this.handleIncomingThreshold(telegramUserId, chatId, rawText);
      return;
    }

    switch (command ?? text) {
      case '/start':
        await this.sendMenu(chatId);
        break;
      case '/quota':
      case '/check':
      case '/refresh':
        await this.handleQuota(telegramUserId, chatId);
        break;
      case '/key':
        await this.handleKey(telegramUserId, chatId);
        break;
      case '/key_change':
        this.deps.db.setUserState(telegramUserId, 'awaiting_key');
        await this.deps.telegram.sendMessage(chatId, 'Gửi GoCinema API key mới. Dùng /cancel để hủy.', { reply_markup: menuMarkup() });
        break;
      case '/history':
        await this.deps.telegram.sendMessage(chatId, formatHistoryText(this.deps.db.recentQuotaChecks(telegramUserId, 5), this.deps.timezoneOffsetHours), { reply_markup: menuMarkup() });
        break;
      case '/settings':
        await this.handleSettings(telegramUserId, chatId);
        break;
      case '/alerts_on':
        this.deps.db.setAlertSettings(telegramUserId, true);
        await this.handleSettings(telegramUserId, chatId);
        break;
      case '/alerts_off':
        this.deps.db.setAlertSettings(telegramUserId, false);
        await this.handleSettings(telegramUserId, chatId);
        break;
      case '/threshold_20':
        await this.handleThreshold(telegramUserId, chatId, 20);
        break;
      case '/threshold_10':
        await this.handleThreshold(telegramUserId, chatId, 10);
        break;
      case '/threshold_5':
        await this.handleThreshold(telegramUserId, chatId, 5);
        break;
      case '/threshold_custom':
        this.deps.db.setUserState(telegramUserId, 'awaiting_threshold');
        await this.deps.telegram.sendMessage(chatId, 'Gửi ngưỡng cảnh báo quota từ 1 đến 100. Dùng /cancel để hủy.', { reply_markup: menuMarkup() });
        break;
      case '/clear':
        this.deps.db.clearUserState(telegramUserId);
        await this.deps.telegram.sendMessage(chatId, clearConversationText(), { reply_markup: menuMarkup() });
        break;
      case '/cancel':
        this.deps.db.clearUserState(telegramUserId);
        await this.deps.telegram.sendMessage(chatId, 'Đã hủy thao tác đang nhập.', { reply_markup: menuMarkup() });
        break;
      case '/help':
        await this.deps.telegram.sendMessage(chatId, formatHelpText(), { reply_markup: menuMarkup() });
        break;
      default:
        await this.deps.telegram.sendMessage(chatId, formatHelpText(), { reply_markup: menuMarkup() });
        break;
    }
  }

  private async sendMenu(chatId: number): Promise<void> {
    await this.deps.telegram.sendMessage(chatId, 'GoCinema Assistant\nChọn thao tác bên dưới hoặc gõ / để xem lệnh.', { reply_markup: menuMarkup() });
  }

  private async handleIncomingKey(identity: BotUserIdentity, chatId: number, apiKey: string): Promise<void> {
    try {
      const summary = await this.deps.api.checkKey(apiKey);
      this.deps.db.saveUserKey(identity, chatId, apiKey, summary.keyMasked);
      this.deps.db.clearUserState(identity.id);
      this.logQuota(identity.id, 'manual', summary);
      const settings = this.deps.db.getSettings(identity.id);
      await this.deps.telegram.sendMessage(chatId, formatQuotaMessage({
        summary,
        alertsEnabled: settings.alertsEnabled,
        alertThresholdPercent: settings.alertThresholdPercent,
        timezoneOffsetHours: this.deps.timezoneOffsetHours,
      }), { reply_markup: menuMarkup() });
    } catch (error) {
      const message = userErrorMessage(error);
      this.deps.db.logQuotaCheck({ telegramUserId: identity.id, source: 'manual', success: false, maskedKey: null, error: message });
      await this.deps.telegram.sendMessage(chatId, `Không kiểm tra được key: ${message}\nGửi key khác hoặc dùng /cancel.`, { reply_markup: menuMarkup() });
    }
  }

  private async handleQuota(telegramUserId: number, chatId: number): Promise<void> {
    const user = this.deps.db.getUser(telegramUserId);
    if (!user?.apiKey) {
      await this.deps.telegram.sendMessage(chatId, noKeyText(), { reply_markup: menuMarkup() });
      return;
    }
    try {
      const summary = await this.deps.api.checkKey(user.apiKey);
      this.logQuota(telegramUserId, 'manual', summary);
      const settings = this.deps.db.getSettings(telegramUserId);
      await this.deps.telegram.sendMessage(chatId, formatQuotaMessage({
        summary,
        alertsEnabled: settings.alertsEnabled,
        alertThresholdPercent: settings.alertThresholdPercent,
        timezoneOffsetHours: this.deps.timezoneOffsetHours,
      }), { reply_markup: menuMarkup() });
    } catch (error) {
      const message = userErrorMessage(error);
      this.deps.db.logQuotaCheck({ telegramUserId, source: 'manual', success: false, maskedKey: user.keyMasked, error: message });
      await this.deps.telegram.sendMessage(chatId, `Không kiểm tra được quota: ${message}`, { reply_markup: menuMarkup() });
    }
  }

  private async handleKey(telegramUserId: number, chatId: number): Promise<void> {
    const user = this.deps.db.getUser(telegramUserId);
    await this.deps.telegram.sendMessage(chatId, formatKeyText({ keyMasked: user?.keyMasked }), { reply_markup: menuMarkup() });
  }

  private async handleSettings(telegramUserId: number, chatId: number): Promise<void> {
    const settings = this.deps.db.getSettings(telegramUserId);
    await this.deps.telegram.sendMessage(chatId, formatSettingsText(settings), { reply_markup: menuMarkup() });
  }

  private async handleThreshold(telegramUserId: number, chatId: number, thresholdPercent: number): Promise<void> {
    const current = this.deps.db.getSettings(telegramUserId);
    this.deps.db.setAlertSettings(telegramUserId, current.alertsEnabled, thresholdPercent);
    await this.handleSettings(telegramUserId, chatId);
  }

  private async handleIncomingThreshold(telegramUserId: number, chatId: number, rawThreshold: string): Promise<void> {
    const thresholdPercent = Number(rawThreshold);
    if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) {
      await this.deps.telegram.sendMessage(chatId, 'Ngưỡng phải là số nguyên từ 1 đến 100. Gửi lại hoặc dùng /cancel.', { reply_markup: menuMarkup() });
      return;
    }
    const current = this.deps.db.getSettings(telegramUserId);
    this.deps.db.setAlertSettings(telegramUserId, current.alertsEnabled, thresholdPercent);
    this.deps.db.clearUserState(telegramUserId);
    await this.handleSettings(telegramUserId, chatId);
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

function identityFromMessage(from: NonNullable<TelegramUpdate['message']>['from']): BotUserIdentity {
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
