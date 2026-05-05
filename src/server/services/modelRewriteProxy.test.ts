import { describe, expect, it } from 'vitest';
import { applyModelRewrite } from './modelRewriteProxy.js';

const cfg = { enabled: true, rules: [{ id: 1, enabled: true, fromModel: 'v1/cx/gpt-5.5', toModel: 'cx/gpt-5.5' }] };

describe('applyModelRewrite', () => {
  it('passes through when globally disabled', () => {
    const raw = Buffer.from('{"model":"v1/cx/gpt-5.5"}');
    const res = applyModelRewrite(raw, 'application/json', { ...cfg, enabled: false });
    expect(res.rewritten).toBe(false);
    expect(res.body).toBe(raw);
  });

  it('passes through no-rule requests with raw body unchanged', () => {
    const raw = Buffer.from('{"model":"other","x":1}');
    const res = applyModelRewrite(raw, 'application/json', cfg);
    expect(res.rewritten).toBe(false);
    expect(res.body).toBe(raw);
  });

  it('rewrites configured model', () => {
    const raw = Buffer.from('{"model":"v1/cx/gpt-5.5","stream":true}');
    const res = applyModelRewrite(raw, 'application/json; charset=utf-8', cfg);
    expect(res.rewritten).toBe(true);
    expect(res.fromModel).toBe('v1/cx/gpt-5.5');
    expect(res.toModel).toBe('cx/gpt-5.5');
    expect(JSON.parse(res.body.toString('utf8')).model).toBe('cx/gpt-5.5');
  });

  it('passes through malformed json', () => {
    const raw = Buffer.from('{nope');
    const res = applyModelRewrite(raw, 'application/json', cfg);
    expect(res.rewritten).toBe(false);
    expect(res.body).toBe(raw);
  });
});
