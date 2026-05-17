import { describe, expect, it } from 'vitest';
import { endOfVietnamDayUtc, endOfVietnamMonthUtc, fromVietnamLocalInput, resolveWindow, startOfVietnamDayUtc, startOfVietnamMonthUtc, toVietnamLocalInput, VN_TZ_LABEL } from './time.js';

describe('Vietnam UTC+7 day windows', () => {
  it('starts at 00:00 VN stored as UTC', () => {
    expect(startOfVietnamDayUtc(new Date('2026-05-01T15:00:00.000Z'))).toBe('2026-04-30T17:00:00.000Z');
    expect(endOfVietnamDayUtc(new Date('2026-05-01T15:00:00.000Z'))).toBe('2026-05-01T17:00:00.000Z');
  });
  it('converts datetime-local VN to UTC and back', () => {
    expect(fromVietnamLocalInput('2026-05-02T00:00')).toBe('2026-05-01T17:00:00.000Z');
    expect(toVietnamLocalInput('2026-05-01T17:00:00.000Z')).toBe('2026-05-02T00:00');
    expect(fromVietnamLocalInput(null)).toBeNull();
    expect(toVietnamLocalInput(null)).toBe('');
  });

  it('calculates Vietnam month windows', () => {
    expect(VN_TZ_LABEL).toBe('UTC+7');
    expect(startOfVietnamMonthUtc(new Date('2026-05-17T12:00:00.000Z'))).toBe('2026-04-30T17:00:00.000Z');
    expect(endOfVietnamMonthUtc(new Date('2026-05-17T12:00:00.000Z'))).toBe('2026-05-31T17:00:00.000Z');
  });

  it('resolves manual, daily, monthly, and custom policy windows', () => {
    const now = new Date('2026-05-17T12:00:00.000Z');

    expect(resolveWindow({ reset_policy: 'daily' }, now)).toEqual({ windowStart: '2026-05-16T17:00:00.000Z', windowEnd: '2026-05-17T17:00:00.000Z', resetPolicy: 'daily' });
    expect(resolveWindow({ reset_policy: 'monthly' }, now)).toEqual({ windowStart: '2026-04-30T17:00:00.000Z', windowEnd: '2026-05-31T17:00:00.000Z', resetPolicy: 'monthly' });
    expect(resolveWindow({ window_start: '2026-01-01T00:00:00.000Z', window_end: '2026-02-01T00:00:00.000Z' }, now)).toEqual({ windowStart: '2026-01-01T00:00:00.000Z', windowEnd: '2026-02-01T00:00:00.000Z', resetPolicy: 'manual' });
    expect(resolveWindow({ reset_policy: 'custom' }, now)).toEqual({ windowStart: '1970-01-01T00:00:00.000Z', windowEnd: null, resetPolicy: 'custom' });
  });
});
