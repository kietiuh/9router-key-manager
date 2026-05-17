import { describe, expect, it } from 'vitest';
import { bytes, vnDateTime } from './format';

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
});
