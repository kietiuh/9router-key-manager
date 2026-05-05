import { describe, expect, it } from 'vitest';
import { maskSecret } from './mask.js';

describe('maskSecret', () => {
  it('handles missing and short secrets', () => {
    expect(maskSecret(undefined)).toBe('<none>');
    expect(maskSecret(null)).toBe('<none>');
    expect(maskSecret('short')).toBe('sho…');
  });

  it('keeps only prefix and suffix for long secrets', () => {
    expect(maskSecret('sk-123456789abcdef')).toBe('sk-1234…abcdef');
  });
});
