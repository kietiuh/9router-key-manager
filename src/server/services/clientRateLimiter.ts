import type { ClientRateLimitConfig, ClientRateLimitSnapshot } from '../../shared/types.js';

export type { ClientRateLimitConfig, ClientRateLimitSnapshot } from '../../shared/types.js';

export type ClientRateLimitLease = {
  clientLimited: boolean;
  keyId: string;
  clientRateLimitRpm: number | null;
  clientConcurrencyLimit: number | null;
  clientRateRemaining: number | null;
  clientRateResetAt: string | null;
  clientActive: number;
  release: () => void;
};

type ClientState = {
  timestamps: number[];
  active: number;
};

export const DEFAULT_CLIENT_RATE_LIMIT_CONFIG: ClientRateLimitConfig = {
  enabled: true,
  rpm: 30,
  concurrency: 5,
};

const WINDOW_MS = 60_000;

export class ClientRateLimitAcquireError extends Error {
  statusCode = 429;
  retryAfter: number;

  constructor(
    message: string,
    public readonly type: 'client_rpm_exceeded' | 'client_concurrency_exceeded',
    public readonly keyId: string,
    public readonly snapshot: ClientRateLimitSnapshot[],
    retryAfterSeconds: number,
    public readonly resetAt: string | null = null,
  ) {
    super(message);
    this.retryAfter = Math.max(1, retryAfterSeconds);
  }
}

export function defaultClientRateLimitConfig(): ClientRateLimitConfig {
  return { ...DEFAULT_CLIENT_RATE_LIMIT_CONFIG };
}

export function normalizeClientRateLimitConfig(input: unknown): ClientRateLimitConfig {
  const cfg = typeof input === 'object' && input ? input as Partial<ClientRateLimitConfig> : {};
  return {
    enabled: cfg.enabled === undefined ? DEFAULT_CLIENT_RATE_LIMIT_CONFIG.enabled : Boolean(cfg.enabled),
    rpm: positiveInteger(cfg.rpm, DEFAULT_CLIENT_RATE_LIMIT_CONFIG.rpm),
    concurrency: positiveInteger(cfg.concurrency, DEFAULT_CLIENT_RATE_LIMIT_CONFIG.concurrency),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function disabledLease(keyId: string): ClientRateLimitLease {
  return {
    clientLimited: false,
    keyId,
    clientRateLimitRpm: null,
    clientConcurrencyLimit: null,
    clientRateRemaining: null,
    clientRateResetAt: null,
    clientActive: 0,
    release: () => {},
  };
}

function limitedLease(
  keyId: string,
  cfg: ClientRateLimitConfig,
  remaining: number,
  resetAt: string | null,
  active: number,
  release: () => void,
): ClientRateLimitLease {
  return {
    clientLimited: true,
    keyId,
    clientRateLimitRpm: cfg.rpm,
    clientConcurrencyLimit: cfg.concurrency,
    clientRateRemaining: remaining,
    clientRateResetAt: resetAt,
    clientActive: active,
    release,
  };
}

export class ClientRateLimiter {
  private cfg: ClientRateLimitConfig;
  private states = new Map<string, ClientState>();

  constructor(config: ClientRateLimitConfig = defaultClientRateLimitConfig()) {
    this.cfg = normalizeClientRateLimitConfig(config);
  }

  updateConfig(config: ClientRateLimitConfig): void {
    this.cfg = normalizeClientRateLimitConfig(config);
  }

  acquire(keyId: string): ClientRateLimitLease {
    const normalizedKeyId = keyId.trim();
    if (!this.cfg.enabled || !normalizedKeyId) return disabledLease(normalizedKeyId);

    const now = Date.now();
    this.cleanupIdleStates(now);
    const state = this.stateFor(normalizedKeyId);
    this.prune(state, now);

    if (state.active >= this.cfg.concurrency) {
      throw new ClientRateLimitAcquireError(
        'Too many concurrent requests for this API key',
        'client_concurrency_exceeded',
        normalizedKeyId,
        this.snapshot(),
        1,
      );
    }

    if (state.timestamps.length >= this.cfg.rpm) {
      const resetAtMs = state.timestamps[0] + WINDOW_MS;
      throw new ClientRateLimitAcquireError(
        'API key RPM limit exceeded',
        'client_rpm_exceeded',
        normalizedKeyId,
        this.snapshot(),
        Math.ceil((resetAtMs - now) / 1000),
        new Date(resetAtMs).toISOString(),
      );
    }

    state.timestamps.push(now);
    state.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
    };
    const resetAtMs = state.timestamps.length ? state.timestamps[0] + WINDOW_MS : null;
    return limitedLease(
      normalizedKeyId,
      this.cfg,
      Math.max(0, this.cfg.rpm - state.timestamps.length),
      resetAtMs == null ? null : new Date(resetAtMs).toISOString(),
      state.active,
      release,
    );
  }

  snapshot(): ClientRateLimitSnapshot[] {
    const now = Date.now();
    this.cleanupIdleStates(now);
    return [...this.states.entries()].map(([keyId, state]) => {
      this.prune(state, now);
      return {
        keyId,
        enabled: this.cfg.enabled,
        rpm: this.cfg.rpm,
        concurrency: this.cfg.concurrency,
        requestCount: state.timestamps.length,
        active: state.active,
        resetAt: state.timestamps.length ? state.timestamps[0] + WINDOW_MS : null,
      };
    });
  }

  private stateFor(keyId: string): ClientState {
    const existing = this.states.get(keyId);
    if (existing) return existing;
    const state = { timestamps: [], active: 0 };
    this.states.set(keyId, state);
    return state;
  }

  private prune(state: ClientState, now: number): void {
    const cutoff = now - WINDOW_MS;
    while (state.timestamps.length && state.timestamps[0] <= cutoff) state.timestamps.shift();
  }

  private cleanupIdleStates(now: number): void {
    for (const [keyId, state] of this.states) {
      this.prune(state, now);
      if (state.active <= 0 && state.timestamps.length === 0) this.states.delete(keyId);
    }
  }
}

export function buildClientRateLimitErrorBody(err: ClientRateLimitAcquireError) {
  return {
    error: {
      message: err.message,
      type: 'rate_limit_exceeded',
      code: err.type,
      retry_after: err.retryAfter,
      reset_at: err.resetAt,
    },
  };
}
