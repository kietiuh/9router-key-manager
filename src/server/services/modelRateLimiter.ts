import type { ModelRateLimitConfig, ModelRateLimitRule, ModelRateLimitSnapshot } from '../../shared/types.js';

export type { ModelRateLimitConfig, ModelRateLimitRule, ModelRateLimitSnapshot } from '../../shared/types.js';

export type ModelRateLimitLease = {
  rateLimited: boolean;
  rateLimitModel: string;
  rateLimitRpm: number | null;
  rateQueuedMs: number;
  release: () => void;
};

type QueueEntry = {
  timer?: NodeJS.Timeout;
  model: string;
  resolve: (lease: ModelRateLimitLease) => void;
};

type ModelState = {
  nextAvailableAt: number;
  queued: Set<QueueEntry>;
};

const DEFAULT_RULE = {
  rpm: 12,
  queueLimit: 100,
  maxQueueWaitMs: 300_000,
};

export class ModelRateLimitAcquireError extends Error {
  statusCode = 429;
  retryAfter: number;

  constructor(
    message: string,
    public readonly type: 'rate_queue_full' | 'rate_queue_timeout',
    public readonly model: string,
    public readonly snapshot: ModelRateLimitSnapshot[],
    retryAfterSeconds: number,
  ) {
    super(message);
    this.retryAfter = Math.max(1, retryAfterSeconds);
  }
}

export function defaultModelRateLimitConfig(): ModelRateLimitConfig {
  return { enabled: false, rules: [] };
}

export function normalizeModelRateLimitConfig(input: unknown): ModelRateLimitConfig {
  const cfg = typeof input === 'object' && input ? input as Partial<ModelRateLimitConfig> : {};
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  return {
    enabled: Boolean(cfg.enabled),
    rules: rules.flatMap(rule => normalizeRule(rule)),
  };
}

function normalizeRule(input: unknown): ModelRateLimitRule[] {
  const rule = typeof input === 'object' && input ? input as Partial<ModelRateLimitRule> : {};
  const model = String(rule.model ?? '').trim();
  if (!model) return [];
  return [{
    model,
    enabled: rule.enabled !== false,
    rpm: positiveNumber(rule.rpm, DEFAULT_RULE.rpm),
    queueLimit: nonnegativeInteger(rule.queueLimit, DEFAULT_RULE.queueLimit),
    maxQueueWaitMs: positiveNumber(rule.maxQueueWaitMs, DEFAULT_RULE.maxQueueWaitMs),
  }];
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonnegativeInteger(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function noLimit(model: string): ModelRateLimitLease {
  return { rateLimited: false, rateLimitModel: model, rateLimitRpm: null, rateQueuedMs: 0, release: () => {} };
}

function limitedLease(model: string, rpm: number, queuedMs: number): ModelRateLimitLease {
  return { rateLimited: true, rateLimitModel: model, rateLimitRpm: rpm, rateQueuedMs: queuedMs, release: () => {} };
}

export class ModelRateLimiter {
  private cfg: ModelRateLimitConfig;
  private states = new Map<string, ModelState>();

  constructor(config: ModelRateLimitConfig = defaultModelRateLimitConfig()) {
    this.cfg = normalizeModelRateLimitConfig(config);
  }

  updateConfig(config: ModelRateLimitConfig): void {
    const next = normalizeModelRateLimitConfig(config);
    const enabledModels = new Set(next.enabled ? next.rules.filter(rule => rule.enabled).map(rule => rule.model) : []);
    for (const model of this.states.keys()) {
      if (!enabledModels.has(model)) {
        const state = this.states.get(model);
        if (state) this.releaseQueued(state, model);
        this.states.delete(model);
      }
    }
    this.cfg = next;
  }

  async acquire(model: string): Promise<ModelRateLimitLease> {
    const rule = this.ruleFor(model);
    if (!rule) return noLimit(model);

    const started = Date.now();
    const intervalMs = Math.ceil(60_000 / rule.rpm);
    const state = this.stateFor(model);
    const now = Date.now();
    const reservedAt = Math.max(now, state.nextAvailableAt);
    const delayMs = reservedAt - now;
    const retryAfter = Math.ceil(Math.max(delayMs, intervalMs) / 1000);

    if (delayMs <= 0) {
      state.nextAvailableAt = now + intervalMs;
      return limitedLease(model, rule.rpm, 0);
    }

    if (state.queued.size >= rule.queueLimit) {
      throw new ModelRateLimitAcquireError(`model rate queue full: ${model}`, 'rate_queue_full', model, this.snapshot(), retryAfter);
    }
    if (delayMs > rule.maxQueueWaitMs) {
      throw new ModelRateLimitAcquireError(`model rate queue timeout: ${model}`, 'rate_queue_timeout', model, this.snapshot(), retryAfter);
    }

    state.nextAvailableAt = reservedAt + intervalMs;
    return new Promise<ModelRateLimitLease>(resolve => {
      const entry: QueueEntry = { model, resolve };
      state.queued.add(entry);
      entry.timer = setTimeout(() => {
        state.queued.delete(entry);
        resolve(limitedLease(model, rule.rpm, Date.now() - started));
      }, delayMs);
      entry.timer.unref?.();
    });
  }

  snapshot(): ModelRateLimitSnapshot[] {
    return this.cfg.rules.map(rule => {
      const state = this.states.get(rule.model);
      return {
        model: rule.model,
        enabled: this.cfg.enabled && rule.enabled,
        rpm: rule.rpm,
        queued: state?.queued.size ?? 0,
        queueLimit: rule.queueLimit,
        nextAvailableAt: state?.nextAvailableAt ?? 0,
      };
    });
  }

  private ruleFor(model: string): ModelRateLimitRule | undefined {
    if (!this.cfg.enabled) return undefined;
    const normalized = model.trim();
    return this.cfg.rules.find(rule => rule.enabled && rule.rpm > 0 && rule.model === normalized);
  }

  private stateFor(model: string): ModelState {
    const existing = this.states.get(model);
    if (existing) return existing;
    const state = { nextAvailableAt: 0, queued: new Set<QueueEntry>() };
    this.states.set(model, state);
    return state;
  }

  private releaseQueued(state: ModelState, model: string): void {
    for (const entry of state.queued) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(noLimit(entry.model || model));
    }
    state.queued.clear();
  }
}
