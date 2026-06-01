export type UpstreamTimeoutConfig = {
  largeContextThresholdTokens: number;
  modelTimeouts: Record<string, { timeoutMs: number }>;
  upstreamTimeouts: Record<string, { timeoutMs: number; largeContextTimeoutMs?: number }>;
};

export function readUpstreamTimeoutConfig(env: NodeJS.ProcessEnv): UpstreamTimeoutConfig {
  return {
    largeContextThresholdTokens: num(env.TRAFFIC_LARGE_CONTEXT_TOKENS, 100000),
    modelTimeouts: parseLegacyModelTimeouts(env.TRAFFIC_MODEL_LIMITS ?? 'cx/gpt-5.5:3:30:120000,*:20:100:120000'),
    upstreamTimeouts: parseUpstreamTimeouts(env.TRAFFIC_UPSTREAM_TIMEOUTS ?? ''),
  };
}

export function timeoutForModel(cfg: UpstreamTimeoutConfig, model: string, large = false): number {
  const override = cfg.upstreamTimeouts[model] ?? cfg.upstreamTimeouts['*'];
  const base = override?.timeoutMs ?? cfg.modelTimeouts[model]?.timeoutMs ?? cfg.modelTimeouts['*']?.timeoutMs ?? 120000;
  return large ? override?.largeContextTimeoutMs ?? Math.max(base, 180000) : base;
}

function parseLegacyModelTimeouts(raw: string) {
  const out: UpstreamTimeoutConfig['modelTimeouts'] = {};
  for (const item of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [model, _concurrency, _queue, timeout] = item.split(':');
    if (!model) continue;
    out[model] = { timeoutMs: num(timeout, 120000) };
  }
  return out;
}

function parseUpstreamTimeouts(raw: string) {
  const out: UpstreamTimeoutConfig['upstreamTimeouts'] = {};
  for (const item of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [model, normal, large] = item.split(':');
    if (!model || !normal) continue;
    const timeoutMs = num(normal, 120000);
    out[model] = { timeoutMs, largeContextTimeoutMs: large ? num(large, Math.max(timeoutMs, 180000)) : undefined };
  }
  return out;
}

function num(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
