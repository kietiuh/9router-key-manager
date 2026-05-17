import { describe, expect, it } from 'vitest';
import { enhanceImagePrompt, IMAGE_PROMPT_QUALITY_SUFFIX } from './publicImage.js';

describe('public image prompt enhancement', () => {
  it('appends the production quality suffix once', () => {
    expect(enhanceImagePrompt('cute robot cat')).toBe(`cute robot cat, ${IMAGE_PROMPT_QUALITY_SUFFIX}`);
  });

  it('does not append the production quality suffix twice', () => {
    const prompt = `cute robot cat, ${IMAGE_PROMPT_QUALITY_SUFFIX}`;

    expect(enhanceImagePrompt(prompt)).toBe(prompt);
  });
});
