import { describe, expect, it } from 'vitest';
import { maskSecret } from './mask.js';

describe('maskSecret', () => {
  it('handles empty, short, and long secrets', () => {
    expect(maskSecret(undefined)).toBe('<none>');
    expect(maskSecret(null)).toBe('<none>');
    expect(maskSecret('short')).toBe('sho…');
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-1234…abcdef');
  });
});
