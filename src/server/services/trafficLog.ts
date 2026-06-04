export type TrafficLogMeta = {
  model: string;
  userId: string;
  bodyBytes: number;
  estimatedInputTokens: number;
  isLargeContext: boolean;
  queuedMs: number;
  rateQueuedMs: number;
  rateLimitModel: string;
  rateLimitRpm: number | null;
  rateLimited: boolean;
  upstreamMs: number;
  upstreamTimeoutMs: number;
  totalMs: number;
  upstreamStatus: number;
  attemptIndex: number;
  attemptCount: number;
  clientRateLimited: boolean;
  clientRateLimitRpm: number | null;
  clientConcurrencyLimit: number | null;
  clientRateRemaining: number | null;
  clientActive: number;
  limiter?: unknown;
};

export function buildTrafficLogMeta(
  input: TrafficLogMeta & { limiter: unknown },
  options: { includeLimiter?: boolean } = {},
): TrafficLogMeta {
  const {
    model,
    userId,
    bodyBytes,
    estimatedInputTokens,
    isLargeContext,
    queuedMs,
    rateQueuedMs,
    rateLimitModel,
    rateLimitRpm,
    rateLimited,
    upstreamMs,
    upstreamTimeoutMs,
    totalMs,
    upstreamStatus,
    attemptIndex,
    attemptCount,
    clientRateLimited,
    clientRateLimitRpm,
    clientConcurrencyLimit,
    clientRateRemaining,
    clientActive,
    limiter,
  } = input;
  const meta: TrafficLogMeta = {
    model,
    userId,
    bodyBytes,
    estimatedInputTokens,
    isLargeContext,
    queuedMs,
    rateQueuedMs,
    rateLimitModel,
    rateLimitRpm,
    rateLimited,
    upstreamMs,
    upstreamTimeoutMs,
    totalMs,
    upstreamStatus,
    attemptIndex,
    attemptCount,
    clientRateLimited,
    clientRateLimitRpm,
    clientConcurrencyLimit,
    clientRateRemaining,
    clientActive,
  };
  if (options.includeLimiter) meta.limiter = limiter;
  return meta;
}
