import { describe, expect, it } from 'vitest';
import { BOT_ACTIONS } from './actions.js';
import {
  formatHelpText,
  formatHistoryText,
  formatHomeText,
  formatKeyText,
  formatQuotaMessage,
  formatSettingsText,
  homeMarkup,
  menuMarkup,
  noKeyText,
  quotaMarkup,
  settingsMarkup,
} from './formatting.js';

describe('bot formatting', () => {
  it('builds an extensible client menu', () => {
    expect(menuMarkup()).toEqual({
      keyboard: [
        [{ text: '📊 Quota' }, { text: '🔑 Key' }],
        [{ text: '🔔 Thông báo' }, { text: '📜 Lịch sử' }],
        [{ text: '⚙️ Cài đặt' }, { text: '❓ Trợ giúp' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    });
  });

  it('builds inline keyboards for message-level actions', () => {
    expect(homeMarkup().inline_keyboard[0]).toEqual([
      { text: '📊 Quota', callback_data: BOT_ACTIONS.QUOTA },
      { text: '🔑 Key', callback_data: BOT_ACTIONS.KEY },
    ]);
    expect(quotaMarkup().inline_keyboard[0]).toEqual([{ text: '🔄 Làm mới quota', callback_data: BOT_ACTIONS.QUOTA }]);
    expect(settingsMarkup({ alertsEnabled: true }).inline_keyboard[0]).toEqual([{ text: '🔕 Tắt cảnh báo', callback_data: BOT_ACTIONS.ALERTS_OFF }]);
    expect(settingsMarkup({ alertsEnabled: false }).inline_keyboard[0]).toEqual([{ text: '🔔 Bật cảnh báo', callback_data: BOT_ACTIONS.ALERTS_ON }]);
  });

  it('formats quota dashboard with key, usage, status, reset, and alert state', () => {
    const message = formatQuotaMessage({
      summary: {
        keyId: 'k1',
        name: 'Client A',
        keyMasked: 'sk-a...test',
        isActive: true,
        status: 'warning',
        statusReason: 'Token usage above 80%',
        windowStart: '2026-05-23T17:00:00.000Z',
        windowEnd: '2026-05-24T17:00:00.000Z',
        resetPolicy: 'daily',
        expiresAt: null,
        tokenLimit: 10000,
        imageDailyLimit: 20,
        imageDailyUsed: 3,
        actionOnLimit: 'disable',
        usageMultiplier: 1,
        actualPrompt: 4000,
        actualCompletion: 4500,
        actualTotal: 8500,
        dedupedRequests: 11,
        duplicateRequests: 0,
        duplicateTokens: 0,
        req: 11,
        prompt: 4000,
        completion: 4500,
        total: 8500,
        cost: 0,
        percentOfLimit: 85,
        firstUsageAt: '2026-05-24T01:00:00.000Z',
        lastUsageAt: '2026-05-24T02:00:00.000Z',
        models: {},
        modelUsage: [],
      },
      alertsEnabled: true,
      alertThresholdPercent: 20,
      timezoneOffsetHours: 7,
    });

    expect(message).toContain('📊 Quota của bạn');
    expect(message).toContain('Client A');
    expect(message).toContain('sk-a...test');
    expect(message).toContain('⚠️ Sắp hết quota');
    expect(message).toContain('Đã dùng: 8.500 / 10.000 token (85%)');
    expect(message).toContain('Còn lại: 1.500 token');
    expect(message).toContain('85%');
    expect(message).toContain('Cảnh báo quota: bật, ngưỡng 20%');
    expect(message).toContain('Reset lúc: 00:00 25/05/2026');
    expect(message).toContain('Lần dùng gần nhất: 09:00 24/05/2026');
    expect(message).not.toContain('Token usage above 80%');
    expect(message).not.toContain('Trạng thái: warning');
  });

  it('keeps healthy quota text friendly and hides raw technical reasons', () => {
    const message = formatQuotaMessage({
      summary: {
        keyId: 'k1',
        name: 'key 1',
        keyMasked: 'sk-46d1...f636f9',
        isActive: true,
        status: 'ok',
        statusReason: 'Healthy',
        windowStart: '2026-05-23T17:00:00.000Z',
        windowEnd: '2026-05-24T17:00:00.000Z',
        resetPolicy: 'daily',
        expiresAt: null,
        tokenLimit: 100_000_000,
        imageDailyLimit: null,
        imageDailyUsed: 0,
        actionOnLimit: 'disable',
        usageMultiplier: 1,
        actualPrompt: 3_000_000,
        actualCompletion: 3_906_298,
        actualTotal: 6_906_298,
        dedupedRequests: 136,
        duplicateRequests: 0,
        duplicateTokens: 0,
        req: 136,
        prompt: 3_000_000,
        completion: 3_906_298,
        total: 6_906_298,
        cost: 0,
        percentOfLimit: 6.906298,
        firstUsageAt: '2026-05-24T01:00:00.000Z',
        lastUsageAt: '2026-05-24T14:59:00.000Z',
        models: {},
        modelUsage: [],
      },
      alertsEnabled: false,
      alertThresholdPercent: 10,
      timezoneOffsetHours: 7,
    });

    expect(message).toContain('✅ Đang hoạt động');
    expect(message).toContain('Đã dùng: 6.906.298 / 100.000.000 token (7%)');
    expect(message).toContain('Còn lại: 93.093.702 token');
    expect(message).toContain('Lần dùng gần nhất: 21:59 24/05/2026');
    expect(message).toContain('Cảnh báo quota: đang tắt');
    expect(message).not.toContain('Healthy');
    expect(message).not.toContain('UTC+7');
  });

  it('formats help, missing key, key, and settings text', () => {
    expect(formatHomeText()).toContain('GoCinema Assistant');
    expect(formatHelpText()).toContain('Dùng các nút bên dưới');
    expect(formatHelpText()).not.toContain('/clear');
    expect(formatHelpText()).toContain('/cancel');
    expect(noKeyText()).toContain('Bấm Lưu key');
    expect(formatKeyText({ keyMasked: 'sk-a...test' })).toContain('sk-a...test');
    const settings = formatSettingsText({ alertsEnabled: false, alertThresholdPercent: 10 });
    expect(settings).toContain('Cảnh báo quota: đang tắt');
    expect(settings).toContain('Chọn nút bên dưới');
  });

  it('formats history entries with compact Vietnamese timestamps', () => {
    const message = formatHistoryText([{
      success: true,
      maskedKey: 'sk-a...test',
      status: 'ok',
      total: 120,
      tokenLimit: 1000,
      percentOfLimit: 12,
      error: null,
      checkedAt: '2026-05-24T02:00:00.000Z',
    }], 7);

    expect(message).toContain('09:00 24/05/2026');
    expect(message).toContain('Đang hoạt động');
    expect(message).toContain('120 / 1.000 token (12%)');
    expect(message).not.toContain('UTC+7');
  });
});
