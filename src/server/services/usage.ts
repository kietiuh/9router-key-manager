import type { ApiKeyRecord, KeyUsageSummary, UsageRecord } from '../../shared/types.js';
import { maskSecret } from '../utils/mask.js';

export type Policy = {
  key_id: string;
  name?: string | null;
  window_start: string;
  window_end?: string | null;
  reset_policy?: 'manual' | 'daily' | 'monthly' | 'custom' | null;
  token_limit?: number | null;
  expires_at?: string | null;
  action_on_limit?: 'alert' | 'disable' | 'none' | null;
  usage_multiplier?: number | null;
  usage_multiplier_effective_at?: string | null;
};

function dedupeSignature(r: UsageRecord): string {
  const t = r.tokens ?? {};
  return [r.apiKey ?? '', (r as any).provider ?? '', (r as any).connectionId ?? '', r.timestamp, r.model ?? '', t.prompt_tokens ?? 0, t.completion_tokens ?? 0, t.total_tokens ?? ''].join('|');
}

function richness(r: UsageRecord): number {
  const t = r.tokens ?? {};
  return Number(t.cache_read_input_tokens != null) + Number(t.cache_creation_input_tokens != null) + Number(t.reasoning_tokens != null) + Number((r as any).endpoint != null);
}

function betterUsageRecord(a: UsageRecord, b: UsageRecord): UsageRecord {
  const ar = richness(a), br = richness(b);
  if (br !== ar) return br > ar ? b : a;
  return (b.cost ?? Number.POSITIVE_INFINITY) < (a.cost ?? Number.POSITIVE_INFINITY) ? b : a;
}

function tokenTotal(r: UsageRecord): number {
  const t = r.tokens ?? {};
  return t.total_tokens ?? ((t.prompt_tokens ?? 0) + (t.completion_tokens ?? 0));
}

export function summarizeKeyUsage(keys: ApiKeyRecord[], usage: UsageRecord[], policies: Policy[], nowIso = new Date().toISOString()): KeyUsageSummary[] {
  const policyById = new Map(policies.map(p => [p.key_id, p]));
  return keys.map(key => {
    const p = policyById.get(key.id);
    const windowStart = p?.window_start ?? '1970-01-01T00:00:00.000Z';
    const windowEnd = p?.window_end ?? null;
    const models = new Map<string, number>();
    const modelUsage = new Map<string, { req: number; prompt: number; completion: number; lastUsageAt: string | null }>();
    const multiplier = Math.max(0, p?.usage_multiplier ?? 1);
    const multiplierEffectiveAt = p?.usage_multiplier_effective_at ?? null;
    const deduped = new Map<string, UsageRecord>();
    let duplicateRequests = 0, duplicateTokens = 0;
    for (const r of usage) {
      if (r.apiKey !== key.key) continue;
      if (r.timestamp < windowStart) continue;
      if (windowEnd && r.timestamp >= windowEnd) continue;
      const sig = dedupeSignature(r);
      const existing = deduped.get(sig);
      if (existing) {
        duplicateRequests++;
        duplicateTokens += tokenTotal(r);
        deduped.set(sig, betterUsageRecord(existing, r));
      } else {
        deduped.set(sig, r);
      }
    }
    let req = 0, prompt = 0, completion = 0, total = 0, actualPrompt = 0, actualCompletion = 0, actualTotal = 0, cost = 0;
    let firstUsageAt: string | null = null, lastUsageAt: string | null = null;
    for (const r of deduped.values()) {
      const factor = multiplierEffectiveAt && r.timestamp >= multiplierEffectiveAt ? multiplier : 1;
      const rawPrompt = r.tokens?.prompt_tokens ?? 0;
      const rawCompletion = r.tokens?.completion_tokens ?? 0;
      const rawTotal = tokenTotal(r);
      const adjPrompt = Math.round(rawPrompt * factor);
      const adjCompletion = Math.round(rawCompletion * factor);
      const adjTotal = r.tokens?.total_tokens != null ? Math.round(rawTotal * factor) : adjPrompt + adjCompletion;
      req++;
      actualPrompt += rawPrompt; actualCompletion += rawCompletion; actualTotal += rawTotal;
      prompt += adjPrompt;
      completion += adjCompletion;
      total += adjTotal;
      cost += (r.cost ?? 0) * factor;
      if (!firstUsageAt || r.timestamp < firstUsageAt) firstUsageAt = r.timestamp;
      if (!lastUsageAt || r.timestamp > lastUsageAt) lastUsageAt = r.timestamp;
      const model = r.model ?? '?';
      const existing = modelUsage.get(model) ?? { req: 0, prompt: 0, completion: 0, lastUsageAt: null };
      existing.req++;
      existing.prompt += adjPrompt;
      existing.completion += adjCompletion;
      if (!existing.lastUsageAt || r.timestamp > existing.lastUsageAt) existing.lastUsageAt = r.timestamp;
      modelUsage.set(model, existing);
      models.set(model, existing.req);
    }
    const limit = p?.token_limit ?? null;
    const percent = limit ? total / limit * 100 : null;
    const expired = !!p?.expires_at && p.expires_at <= nowIso;
    const status = !key.isActive ? 'inactive'
      : expired ? 'expired'
      : percent != null && percent >= 100 ? 'danger'
      : percent != null && percent >= 80 ? 'warning'
      : !limit ? 'unlimited'
      : 'ok';
    const statusReason = !key.isActive ? 'Key is inactive'
      : expired ? 'Key is expired'
      : percent != null && percent >= 100 ? 'Token limit reached'
      : percent != null && percent >= 80 ? 'Token usage above 80%'
      : !limit ? 'No token limit configured'
      : 'Healthy';
    return {
      keyId: key.id,
      name: p?.name ?? key.name,
      keyMasked: maskSecret(key.key),
      isActive: key.isActive,
      status,
      statusReason,
      windowStart,
      windowEnd,
      resetPolicy: p?.reset_policy ?? 'manual',
      expiresAt: p?.expires_at ?? null,
      tokenLimit: limit,
      actionOnLimit: p?.action_on_limit ?? 'alert',
      usageMultiplier: multiplier,
      usageMultiplierEffectiveAt: multiplierEffectiveAt,
      actualPrompt, actualCompletion, actualTotal,
      dedupedRequests: req, duplicateRequests, duplicateTokens,
      req, prompt, completion, total, cost,
      percentOfLimit: percent,
      firstUsageAt, lastUsageAt,
      models: Object.fromEntries([...models.entries()].sort((a,b)=>b[1]-a[1])),
      modelUsage: [...modelUsage.entries()].map(([model, stats]) => ({ model, ...stats })).sort((a,b)=>b.req-a.req),
    };
  });
}

export function defaultWindowStart(nowIso = new Date().toISOString()): string {
  return nowIso;
}
