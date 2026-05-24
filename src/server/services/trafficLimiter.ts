export type TrafficLimitConfig = {
  enabled: boolean;
  globalMaxConcurrent: number;
  perUserMaxConcurrent: number;
  perUserQueueLimit: number;
  largeContextThresholdTokens: number;
  largeContextMaxConcurrent: number;
  largeContextQueueLimit: number;
  queueTimeoutMs: number;
  largeContextQueueTimeoutMs: number;
  modelLimits: Record<string, { maxConcurrent: number; queueLimit: number; timeoutMs: number }>;
  upstreamTimeouts: Record<string, { timeoutMs: number; largeContextTimeoutMs?: number }>;
};

export type TrafficClass = {
  model: string;
  userId: string;
  estimatedInputTokens: number;
  isLargeContext: boolean;
};

export type TrafficLease = {
  queuedMs: number;
  timeoutMs: number;
  release: () => void;
};

type Queued = { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

class LimitGroup {
  active = 0;
  queue: Queued[] = [];
  constructor(public readonly name: string, public readonly maxConcurrent: number, public readonly queueLimit: number) {}

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.maxConcurrent <= 0) throw new Error(`traffic limiter ${this.name} disabled`);
    if (this.active < this.maxConcurrent) {
      this.active++;
      return () => this.release();
    }
    if (this.queue.length >= this.queueLimit) throw new Error(`traffic queue full: ${this.name}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter(q => q.resolve !== resolve);
        reject(new Error(`traffic queue timeout: ${this.name}`));
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
    });
    return () => this.release();
  }

  private release() {
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class TrafficLimiter {
  private groups = new Map<string, LimitGroup>();
  constructor(private readonly cfg: TrafficLimitConfig) {}

  async acquire(cls: TrafficClass): Promise<TrafficLease> {
    if (!this.cfg.enabled) return { queuedMs: 0, timeoutMs: this.timeoutFor(cls.model, cls.isLargeContext), release: () => {} };
    const started = Date.now();
    const names = this.groupSpecs(cls);
    const releases: Array<() => void> = [];
    try {
      for (const spec of names) releases.push(await this.group(spec.name, spec.maxConcurrent, spec.queueLimit).acquire(spec.timeoutMs));
      return { queuedMs: Date.now() - started, timeoutMs: this.timeoutFor(cls.model, cls.isLargeContext), release: once(() => releases.reverse().forEach(fn => fn())) };
    } catch (err) {
      releases.reverse().forEach(fn => fn());
      throw err;
    }
  }

  snapshot() {
    return Array.from(this.groups.values()).map(g => ({ name: g.name, active: g.active, queued: g.queue.length, maxConcurrent: g.maxConcurrent, queueLimit: g.queueLimit }));
  }

  private groupSpecs(cls: TrafficClass) {
    const modelLimit = this.cfg.modelLimits[cls.model] ?? this.cfg.modelLimits['*'] ?? { maxConcurrent: this.cfg.globalMaxConcurrent, queueLimit: 100, timeoutMs: 120000 };
    const queueTimeoutMs = this.cfg.queueTimeoutMs;
    const specs = [
      { name: 'global', maxConcurrent: this.cfg.globalMaxConcurrent, queueLimit: 200, timeoutMs: queueTimeoutMs },
      { name: `model:${cls.model}`, maxConcurrent: modelLimit.maxConcurrent, queueLimit: modelLimit.queueLimit, timeoutMs: queueTimeoutMs },
      { name: `user:${cls.userId}`, maxConcurrent: this.cfg.perUserMaxConcurrent, queueLimit: this.cfg.perUserQueueLimit, timeoutMs: queueTimeoutMs },
    ];
    if (cls.isLargeContext) specs.push({ name: 'large-context', maxConcurrent: this.cfg.largeContextMaxConcurrent, queueLimit: this.cfg.largeContextQueueLimit, timeoutMs: this.cfg.largeContextQueueTimeoutMs });
    return specs;
  }

  private group(name: string, maxConcurrent: number, queueLimit: number) {
    const existing = this.groups.get(name);
    if (existing) return existing;
    const group = new LimitGroup(name, maxConcurrent, queueLimit);
    this.groups.set(name, group);
    return group;
  }

  private timeoutFor(model: string, large = false) {
    const override = this.cfg.upstreamTimeouts[model] ?? this.cfg.upstreamTimeouts['*'];
    const base = override?.timeoutMs ?? this.cfg.modelLimits[model]?.timeoutMs ?? this.cfg.modelLimits['*']?.timeoutMs ?? 120000;
    return large ? override?.largeContextTimeoutMs ?? Math.max(base, 180000) : base;
  }
}

function once(fn: () => void) {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}

export function readTrafficLimitConfig(env: NodeJS.ProcessEnv): TrafficLimitConfig {
  return {
    enabled: env.TRAFFIC_LIMIT_ENABLED !== 'false',
    globalMaxConcurrent: num(env.TRAFFIC_GLOBAL_MAX_CONCURRENT, 20),
    perUserMaxConcurrent: num(env.TRAFFIC_PER_USER_MAX_CONCURRENT, 2),
    perUserQueueLimit: num(env.TRAFFIC_PER_USER_QUEUE_LIMIT, 10),
    largeContextThresholdTokens: num(env.TRAFFIC_LARGE_CONTEXT_TOKENS, 100000),
    largeContextMaxConcurrent: num(env.TRAFFIC_LARGE_CONTEXT_MAX_CONCURRENT, 1),
    largeContextQueueLimit: num(env.TRAFFIC_LARGE_CONTEXT_QUEUE_LIMIT, 5),
    queueTimeoutMs: num(env.TRAFFIC_QUEUE_TIMEOUT_MS, 120000),
    largeContextQueueTimeoutMs: num(env.TRAFFIC_LARGE_CONTEXT_QUEUE_TIMEOUT_MS, num(env.TRAFFIC_QUEUE_TIMEOUT_MS, 120000)),
    modelLimits: parseModelLimits(env.TRAFFIC_MODEL_LIMITS ?? 'cx/gpt-5.5:3:30:120000,*:20:100:120000'),
    upstreamTimeouts: parseUpstreamTimeouts(env.TRAFFIC_UPSTREAM_TIMEOUTS ?? ''),
  };
}

function parseModelLimits(raw: string) {
  const out: TrafficLimitConfig['modelLimits'] = {};
  for (const item of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [model, c, q, t] = item.split(':');
    if (!model || !c || !q) continue;
    out[model] = { maxConcurrent: num(c, 3), queueLimit: num(q, 30), timeoutMs: num(t, 120000) };
  }
  return out;
}

function parseUpstreamTimeouts(raw: string) {
  const out: TrafficLimitConfig['upstreamTimeouts'] = {};
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
