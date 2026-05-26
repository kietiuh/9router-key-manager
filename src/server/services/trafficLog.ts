export type TrafficLogMeta = {
  model: string;
  userId: string;
  bodyBytes: number;
  estimatedInputTokens: number;
  isLargeContext: boolean;
  queuedMs: number;
  upstreamMs: number;
  upstreamTimeoutMs: number;
  totalMs: number;
  upstreamStatus: number;
  attemptIndex: number;
  attemptCount: number;
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
    upstreamMs,
    upstreamTimeoutMs,
    totalMs,
    upstreamStatus,
    attemptIndex,
    attemptCount,
    limiter,
  } = input;
  const meta: TrafficLogMeta = {
    model,
    userId,
    bodyBytes,
    estimatedInputTokens,
    isLargeContext,
    queuedMs,
    upstreamMs,
    upstreamTimeoutMs,
    totalMs,
    upstreamStatus,
    attemptIndex,
    attemptCount,
  };
  if (options.includeLimiter) meta.limiter = limiter;
  return meta;
}
