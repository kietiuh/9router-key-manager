import { describe, expect, it } from 'vitest';
import {
  PATCH_MARKER,
  patch9routerUsageBundle,
  readSyntheticUsageProviderIds,
} from './9routerSyntheticUsagePatch.js';

const ORIGINAL_QR_SNIPPET =
  'function j({provider:a,model:b,tokens:c,connectionId:f,apiKey:g,endpoint:h,label:i="USAGE"}){if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;let m=new Date().toLocaleTimeString("en-US",{hour12:!1,hour:"2-digit",minute:"2-digit",second:"2-digit"}),n=f?` | account=${f.slice(0,8)}...`:"";console.log(`usage ${k}/${l}`);let o={prompt_tokens:c.prompt_tokens??c.input_tokens??0,completion_tokens:c.completion_tokens??c.output_tokens??0};(0,d.sZ)({provider:a||"unknown",model:b||"unknown",tokens:o,timestamp:new Date().toISOString(),connectionId:f||void 0,apiKey:g||void 0,endpoint:h||null}).catch(()=>{})}';

describe('9router synthetic usage patch', () => {
  it('patches 9router usage writer to randomize missing input and output tokens for selected providers', () => {
    const result = patch9routerUsageBundle(`prefix ${ORIGINAL_QR_SNIPPET} suffix`, {
      providerIds: ['openai-compatible-responses-v4', 'anthropic-compatible-cl'],
    });

    expect(result.changed).toBe(true);
    expect(result.content).toContain(PATCH_MARKER);
    expect(result.content).toContain('openai-compatible-responses-v4');
    expect(result.content).toContain('anthropic-compatible-cl');
    expect(result.content).toContain('if((!c||"object"!=typeof c)&&!r)return;');
    expect(result.content).toContain('c&&"object"==typeof c||(c={});');
    expect(result.content).toContain('Math.random()*50001');
    expect(result.content).toContain('Math.random()*4901');
    expect(result.content).toContain('synthetic_zero_usage_random');
    expect(result.content).toContain('(0,d.sZ)({provider:a||"unknown"');
    expect(result.content).not.toContain('if(!c||"object"!=typeof c)return;let k=c.input_tokens??c.prompt_tokens??0,l=c.output_tokens??c.completion_tokens??0;if(0===k&&0===l)return;');
  });

  it('does not patch an already patched bundle again', () => {
    const first = patch9routerUsageBundle(ORIGINAL_QR_SNIPPET, {
      providerIds: ['openai-compatible-responses-v4'],
    });
    const second = patch9routerUsageBundle(first.content, {
      providerIds: ['openai-compatible-responses-v4'],
    });

    expect(second).toEqual({ changed: false, content: first.content });
  });

  it('throws when the expected 9router usage writer pattern is missing', () => {
    expect(() => patch9routerUsageBundle('function notTheUsageWriter(){}', {
      providerIds: ['openai-compatible-responses-v4'],
    })).toThrow(/usage writer pattern/);
  });

  it('reads v4 and cl provider ids from providerNodes rows', () => {
    const ids = readSyntheticUsageProviderIds([
      { id: 'v4-node', data: '{"prefix":"v4","baseUrl":"https://example.test/v1"}' },
      { id: 'cl-node', data: '{"prefix":"cl","baseUrl":"https://example.test/v1"}' },
      { id: 'other-node', data: '{"prefix":"kr","baseUrl":"https://example.test/v1"}' },
      { id: 'broken-node', data: '{broken' },
    ]);

    expect(ids).toEqual(['cl-node', 'v4-node']);
  });
});
