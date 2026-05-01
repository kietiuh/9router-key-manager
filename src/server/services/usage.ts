import type { ApiKeyRecord, KeyUsageSummary, UsageRecord } from '../../shared/types.js';
import { maskSecret } from '../utils/mask.js';

export type Policy = {
  key_id: string;
  name?: string | null;
  window_start: string;
  window_end?: string | null;
  token_limit?: number | null;
  expires_at?: string | null;
  action_on_limit?: 'alert' | 'disable' | 'none' | null;
};

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
    let req = 0, prompt = 0, completion = 0, total = 0, cost = 0;
    let firstUsageAt: string | null = null, lastUsageAt: string | null = null;
    for (const r of usage) {
      if (r.apiKey !== key.key) continue;
      if (r.timestamp < windowStart) continue;
      if (windowEnd && r.timestamp >= windowEnd) continue;
      req++;
      prompt += r.tokens?.prompt_tokens ?? 0;
      completion += r.tokens?.completion_tokens ?? 0;
      total += tokenTotal(r);
      cost += r.cost ?? 0;
      if (!firstUsageAt || r.timestamp < firstUsageAt) firstUsageAt = r.timestamp;
      if (!lastUsageAt || r.timestamp > lastUsageAt) lastUsageAt = r.timestamp;
      const model = r.model ?? '?';
      models.set(model, (models.get(model) ?? 0) + 1);
    }
    const limit = p?.token_limit ?? null;
    return {
      keyId: key.id,
      name: p?.name ?? key.name,
      keyMasked: maskSecret(key.key),
      isActive: key.isActive,
      windowStart,
      windowEnd,
      expiresAt: p?.expires_at ?? null,
      tokenLimit: limit,
      actionOnLimit: p?.action_on_limit ?? 'alert',
      req, prompt, completion, total, cost,
      percentOfLimit: limit ? total / limit * 100 : null,
      firstUsageAt, lastUsageAt,
      models: Object.fromEntries([...models.entries()].sort((a,b)=>b[1]-a[1])),
    };
  });
}

export function defaultWindowStart(nowIso = new Date().toISOString()): string {
  return nowIso;
}
