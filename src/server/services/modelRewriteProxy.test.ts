import { describe, expect, it } from 'vitest';
import { applyModelRewrite, applyRewritePlan, buildRewriteBody, parseModelRewriteRequest } from './modelRewriteProxy.js';

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

  it('parses only JSON object requests with string model values', () => {
    expect(parseModelRewriteRequest(Buffer.from('{"model":"m"}'), 'Application/JSON')).toMatchObject({ model: 'm', parsedBody: { model: 'm' } });
    expect(parseModelRewriteRequest(Buffer.from('{"model":123}'), 'application/json')).toEqual({ rawBody: Buffer.from('{"model":123}'), parsedBody: { model: 123 }, model: undefined });
    expect(parseModelRewriteRequest(Buffer.from('[]'), 'application/json')).toEqual({ rawBody: Buffer.from('[]') });
    expect(parseModelRewriteRequest(Buffer.from('{"model":"m"}'), 'text/plain')).toEqual({ rawBody: Buffer.from('{"model":"m"}') });
  });

  it('dedupes and trims target models before selecting the first target', () => {
    const raw = Buffer.from('{"model":"source"}');
    const res = applyModelRewrite(raw, 'application/json', {
      enabled: true,
      groups: [{ id: 1, name: 'Main', enabled: true, rules: [{ id: 1, groupId: 1, enabled: true, fromModel: 'source', toModel: 'fallback', toModels: [' target ', 'target', '', 'backup'], stickyCount: 1 }] }],
    });

    expect(res.targets).toEqual(['target', 'backup']);
    expect(JSON.parse(res.body.toString()).model).toBe('target');
  });

  it('passes through explicit rewrite plans missing parsed model context', () => {
    const raw = Buffer.from('plain');
    const decision = applyRewritePlan({ rawBody: raw }, { ruleId: 1, fromModel: 'a', targets: ['b'], selectedModel: 'b', rewritten: true });

    expect(decision.rewritten).toBe(false);
    expect(buildRewriteBody(decision, 'new')).toBe(raw);
  });
});
