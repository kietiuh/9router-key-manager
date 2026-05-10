import { describe, expect, it } from 'vitest';
import { maskSecret } from './mask.js';

describe('maskSecret', () => {
  it('handles empty and short secrets', () => {
    expect(maskSecret(undefined)).toBe('<none>');
    expect(maskSecret(null)).toBe('<none>');
    expect(maskSecret('sk-short')).toBe('sk-…');
  });

  it('keeps long secrets readable at both ends', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-1234…abcdef');
  });
});
