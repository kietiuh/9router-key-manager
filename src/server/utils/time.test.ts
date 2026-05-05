import { describe, expect, it } from 'vitest';
import { startOfVietnamDayUtc, endOfVietnamDayUtc, fromVietnamLocalInput, toVietnamLocalInput, resolveWindow, startOfVietnamMonthUtc, endOfVietnamMonthUtc } from './time.js';

describe('Vietnam UTC+7 day windows', () => {
  it('starts at 00:00 VN stored as UTC', () => {
    expect(startOfVietnamDayUtc(new Date('2026-05-01T15:00:00.000Z'))).toBe('2026-04-30T17:00:00.000Z');
    expect(endOfVietnamDayUtc(new Date('2026-05-01T15:00:00.000Z'))).toBe('2026-05-01T17:00:00.000Z');
  });
  it('converts datetime-local VN to UTC and back', () => {
    expect(fromVietnamLocalInput('2026-05-02T00:00')).toBe('2026-05-01T17:00:00.000Z');
    expect(toVietnamLocalInput('2026-05-01T17:00:00.000Z')).toBe('2026-05-02T00:00');
  });

  it('resolves daily and monthly windows across UTC+7 boundaries', () => {
    expect(resolveWindow({ reset_policy: 'daily', window_start: 'old' }, new Date('2026-12-31T18:00:00.000Z'))).toEqual({ windowStart: '2026-12-31T17:00:00.000Z', windowEnd: '2027-01-01T17:00:00.000Z', resetPolicy: 'daily' });
    expect(startOfVietnamMonthUtc(new Date('2026-12-31T18:00:00.000Z'))).toBe('2026-12-31T17:00:00.000Z');
    expect(endOfVietnamMonthUtc(new Date('2026-12-31T18:00:00.000Z'))).toBe('2027-01-31T17:00:00.000Z');
  });

  it('preserves manual and custom windows', () => {
    expect(resolveWindow({ reset_policy: 'manual', window_start: 'a', window_end: 'b' })).toEqual({ windowStart: 'a', windowEnd: 'b', resetPolicy: 'manual' });
    expect(resolveWindow({ reset_policy: 'custom', window_start: null, window_end: null })).toEqual({ windowStart: '1970-01-01T00:00:00.000Z', windowEnd: null, resetPolicy: 'custom' });
  });
});
