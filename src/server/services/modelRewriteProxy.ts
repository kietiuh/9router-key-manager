import { findModelRewriteRule, type ModelRewriteConfig, type ModelRewriteRule, type RewriteTargetPlan } from './modelRewrite.js';

export type RewriteDecision = {
  rawBody: Buffer;
  body: Buffer;
  parsedBody?: Record<string, unknown>;
  rewritten: boolean;
  fromModel?: string;
  toModel?: string;
  targets: string[];
  model?: string;
};

export type ParsedRewriteRequest = {
  rawBody: Buffer;
  parsedBody?: Record<string, unknown>;
  model?: string;
};

function targetsForRule(rule: ModelRewriteRule): string[] {
  const raw = rule.toModels?.length ? rule.toModels : [rule.toModel];
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const item of raw) {
    const target = String(item ?? '').trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

function passThrough(parsed: ParsedRewriteRequest): RewriteDecision {
  return {
    rawBody: parsed.rawBody,
    body: parsed.rawBody,
    parsedBody: parsed.parsedBody,
    rewritten: false,
    targets: parsed.model ? [parsed.model] : [],
    model: parsed.model,
  };
}

export function parseModelRewriteRequest(rawBody: Buffer, contentType: string | undefined): ParsedRewriteRequest {
  if (!contentType?.toLowerCase().includes('application/json')) return { rawBody };
  let parsed: any;
  try { parsed = JSON.parse(rawBody.toString('utf8')); }
  catch { return { rawBody }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { rawBody };
  return { rawBody, parsedBody: parsed, model: typeof parsed.model === 'string' ? parsed.model : undefined };
}

export function buildRewriteBody(decision: RewriteDecision, model: string): Buffer {
  if (!decision.parsedBody) return decision.body;
  return Buffer.from(JSON.stringify({ ...decision.parsedBody, model }));
}

export function applyRewritePlan(parsed: ParsedRewriteRequest, plan: RewriteTargetPlan | undefined): RewriteDecision {
  if (!parsed.parsedBody || !parsed.model || !plan) return passThrough(parsed);
  const decision: RewriteDecision = {
    rawBody: parsed.rawBody,
    body: parsed.rawBody,
    parsedBody: parsed.parsedBody,
    rewritten: true,
    fromModel: parsed.model,
    toModel: plan.selectedModel,
    targets: plan.targets,
    model: plan.selectedModel,
  };
  return { ...decision, body: buildRewriteBody(decision, plan.selectedModel) };
}

export function applyModelRewrite(rawBody: Buffer, contentType: string | undefined, cfg: ModelRewriteConfig): RewriteDecision {
  const parsed = parseModelRewriteRequest(rawBody, contentType);
  if (!parsed.parsedBody || !parsed.model) return passThrough(parsed);
  if (!cfg.enabled) return passThrough(parsed);
  const rule = findModelRewriteRule(parsed.model, cfg);
  if (!rule) return passThrough(parsed);
  const targets = targetsForRule(rule);
  const selectedModel = targets[0] ?? rule.toModel;
  return applyRewritePlan(parsed, { ruleId: rule.id, fromModel: parsed.model, targets, selectedModel, rewritten: true });
}
