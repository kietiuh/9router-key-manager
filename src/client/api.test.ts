import { describe, expect, it } from 'vitest';
import { messageFromErrorText } from './api';

describe('api error parsing', () => {
  it('extracts flat API errors', () => {
    expect(messageFromErrorText('{"error":"feature disabled"}')).toBe('feature disabled');
  });

  it('extracts nested OpenAI-style API errors', () => {
    expect(messageFromErrorText('{"error":{"message":"Image upstream proxy error","type":"image_proxy_error"}}')).toBe('Image upstream proxy error');
  });

  it('keeps plain text errors readable', () => {
    expect(messageFromErrorText('upstream timeout')).toBe('upstream timeout');
  });
});
