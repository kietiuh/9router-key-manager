import { findModelRewriteRule, type ModelRewriteConfig } from './modelRewrite.js';

export type RewriteDecision = {
  body: Buffer;
  rewritten: boolean;
  fromModel?: string;
  toModel?: string;
  model?: string;
};

export function applyModelRewrite(rawBody: Buffer, contentType: string | undefined, cfg: ModelRewriteConfig): RewriteDecision {
  if (!contentType?.toLowerCase().includes('application/json')) return { body: rawBody, rewritten: false };
  let parsed: any;
  try { parsed = JSON.parse(rawBody.toString('utf8')); }
  catch { return { body: rawBody, rewritten: false }; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.model !== 'string') return { body: rawBody, rewritten: false };
  if (!cfg.enabled) return { body: rawBody, rewritten: false, model: parsed.model };
  const rule = findModelRewriteRule(parsed.model, cfg);
  if (!rule) return { body: rawBody, rewritten: false, model: parsed.model };
  const fromModel = parsed.model;
  parsed.model = rule.toModel;
  return { body: Buffer.from(JSON.stringify(parsed)), rewritten: true, fromModel, toModel: rule.toModel, model: rule.toModel };
}
