import { describe, expect, it } from 'vitest';
import { applyModelRewrite, buildRewriteBody } from './modelRewriteProxy.js';

const cfg = { enabled: true, groups: [{ id: 1, name: 'Main', enabled: true, rules: [{ id: 1, groupId: 1, enabled: true, fromModel: 'v1/cx/gpt-5.5', toModel: 'cx/gpt-5.5', toModels: ['cx/gpt-5.5', 'cx/gpt-5.5-backup'], stickyCount: 1 }] }] };

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
    expect(res.targets).toEqual(['cx/gpt-5.5', 'cx/gpt-5.5-backup']);
    expect(JSON.parse(res.body.toString('utf8')).model).toBe('cx/gpt-5.5');
  });

  it('builds a fresh body for each target without mutating the raw body', () => {
    const raw = Buffer.from('{"model":"v1/cx/gpt-5.5","stream":true}');
    const res = applyModelRewrite(raw, 'application/json', cfg);
    const backup = buildRewriteBody(res, 'cx/gpt-5.5-backup');
    expect(JSON.parse(backup.toString('utf8'))).toEqual({ model: 'cx/gpt-5.5-backup', stream: true });
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ model: 'cx/gpt-5.5', stream: true });
    expect(JSON.parse(raw.toString('utf8'))).toEqual({ model: 'v1/cx/gpt-5.5', stream: true });
  });

  it('passes through rules inside disabled groups', () => {
    const raw = Buffer.from('{"model":"v1/cx/gpt-5.5"}');
    const res = applyModelRewrite(raw, 'application/json', { ...cfg, groups: [{ ...cfg.groups[0], enabled: false }] });
    expect(res.rewritten).toBe(false);
    expect(res.body).toBe(raw);
  });

  it('passes through malformed json', () => {
    const raw = Buffer.from('{nope');
    const res = applyModelRewrite(raw, 'application/json', cfg);
    expect(res.rewritten).toBe(false);
    expect(res.body).toBe(raw);
  });
});
