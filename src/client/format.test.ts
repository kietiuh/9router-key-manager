import { describe, expect, it } from 'vitest';
import { bytes, fmt, fromVnInput, pct, publicDateTime, toVnInput, vnDateTime } from './format';

describe('format numbers', () => {
  it('formats missing and present values', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(1234)).toBe('1,234');
    expect(pct(undefined)).toBe('—');
    expect(pct(12.34)).toBe('12.3%');
  });
});

describe('format bytes', () => {
  it('formats missing values', () => {
    expect(bytes(null)).toBe('—');
  });

  it('formats KiB and MiB', () => {
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(2 * 1024 * 1024)).toBe('2 MB');
    expect(bytes(512)).toBe('512 B');
  });
});

describe('format Vietnam datetime', () => {
  it('treats SQLite CURRENT_TIMESTAMP strings as UTC before showing UTC+7', () => {
    expect(vnDateTime('2026-05-17 04:30:00')).toBe(vnDateTime('2026-05-17T04:30:00Z'));
  });

  it('converts UTC values to and from Vietnam datetime-local input values', () => {
    expect(toVnInput(null)).toBe('');
    expect(toVnInput('2026-05-17 04:30:00')).toBe('2026-05-17T11:30');
    expect(fromVnInput(null)).toBeNull();
    expect(fromVnInput('2026-05-17T11:30')).toBe('2026-05-17T04:30:00.000Z');
  });

  it('formats public timestamps in Vietnam timezone', () => {
    expect(publicDateTime(null)).toBe('—');
    expect(publicDateTime('2026-05-17 04:30:00')).toBe('11:30 17/05/2026');
  });
});
