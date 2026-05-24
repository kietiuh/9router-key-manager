import { describe, expect, it } from 'vitest';
import {
  clearConversationText,
  formatHelpText,
  formatKeyText,
  formatQuotaMessage,
  formatSettingsText,
  menuMarkup,
  noKeyText,
} from './formatting.js';

describe('bot formatting', () => {
  it('builds an extensible client menu', () => {
    expect(menuMarkup()).toEqual({
      keyboard: [
        [{ text: '📊 Quota' }, { text: '🔑 Key' }],
        [{ text: '🔔 Thông báo' }, { text: '🧹 Clear' }],
        [{ text: '📜 Lịch sử' }, { text: '⚙️ Cài đặt' }, { text: '❓ Trợ giúp' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    });
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

    expect(message).toContain('📊 Quota GoCinema');
    expect(message).toContain('Client A');
    expect(message).toContain('sk-a...test');
    expect(message).toContain('8.500 / 10.000 tokens');
    expect(message).toContain('85%');
    expect(message).toContain('Cảnh báo: bật, ngưỡng 20%');
    expect(message).toContain('Reset: 2026-05-25 00:00 UTC+7');
    expect(message).toContain('Trạng thái: warning');
  });

  it('keeps clear scoped to conversation state', () => {
    expect(clearConversationText()).toContain('Đã clear hội thoại hiện tại');
    expect(clearConversationText()).toContain('Key và cài đặt vẫn được giữ');
  });

  it('formats help, missing key, key, and settings text', () => {
    expect(formatHelpText()).toContain('/quota');
    expect(formatHelpText()).toContain('/clear');
    expect(formatHelpText()).toContain('/threshold_custom');
    expect(noKeyText()).toContain('/key_change');
    expect(formatKeyText({ keyMasked: 'sk-a...test' })).toContain('sk-a...test');
    const settings = formatSettingsText({ alertsEnabled: false, alertThresholdPercent: 10 });
    expect(settings).toContain('đang tắt');
    expect(settings).toContain('/threshold_custom');
  });
});
