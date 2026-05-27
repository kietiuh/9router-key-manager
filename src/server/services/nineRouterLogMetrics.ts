import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TrafficSummary } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

type ParsedNineRouterEvent =
  | { kind: 'request'; path: string; model: string }
  | { kind: 'stream'; model: string; durationMs: number; status: 'complete' | 'aborted' | 'error' };

export type JournalLine = {
  realtimeTimestamp: string;
  message: string;
};

type BuildSummaryOptions = {
  nowMs?: number;
  windowMinutes: number;
  bucketMinutes: number;
};

type LatencyAccumulator = {
  sum: number;
  max: number;
};

type Bucket = {
  bucketStartMs: number;
  requestCount: number;
  streamCount: number;
  errorCount: number;
  upstreamMs: LatencyAccumulator;
  latestEventMs: number;
};

type ModelStats = {
  requestCount: number;
  streamCount: number;
  errorCount: number;
  upstreamMs: LatencyAccumulator;
};

const REQUEST_RE = /📥\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/\S+)\s+\|\s+([^|]+)/;
const STREAM_RE = /\[STREAM\]\s+[^|]+\|\s+([^|]+)\|\s+(\d+)ms\s+\|\s+(.+)$/;
const JOURNAL_LINE_LIMIT = 2000;

export function nineRouterJournalArgs(since: string) {
  return ['-u', '9router', '--since', since, '-n', String(JOURNAL_LINE_LIMIT), '-o', 'json', '--no-pager'];
}

function cleanLine(line: string) {
  return line.replaceAll(String.fromCharCode(27), '').replace(/\[[0-9;]*m/g, '').trim();
}

function emptyLatency(): LatencyAccumulator {
  return { sum: 0, max: 0 };
}

function addLatency(acc: LatencyAccumulator, value: number) {
  acc.sum += value;
  acc.max = Math.max(acc.max, value);
}

function latencySummary(acc: LatencyAccumulator, count: number) {
  return { avg: count ? Math.round(acc.sum / count) : 0, max: acc.max };
}

function newBucket(bucketStartMs: number): Bucket {
  return { bucketStartMs, requestCount: 0, streamCount: 0, errorCount: 0, upstreamMs: emptyLatency(), latestEventMs: 0 };
}

function newModelStats(): ModelStats {
  return { requestCount: 0, streamCount: 0, errorCount: 0, upstreamMs: emptyLatency() };
}

function streamStatus(text: string): 'complete' | 'aborted' | 'error' {
  const lower = text.toLowerCase();
  if (lower.includes('complete')) return 'complete';
  if (lower.includes('disconnect') || lower.includes('abort')) return 'aborted';
  return 'error';
}

function normalizeModel(model: string) {
  return model.trim().replace(/^v\d+\//, '') || 'unknown';
}

export function parseNineRouterLogLine(input: string): ParsedNineRouterEvent | null {
  const line = cleanLine(input);
  const request = REQUEST_RE.exec(line);
  if (request) return { kind: 'request', path: request[2], model: request[3].trim() };
  const stream = STREAM_RE.exec(line);
  if (stream) return { kind: 'stream', model: stream[1].trim(), durationMs: Number(stream[2]), status: streamStatus(stream[3]) };
  return null;
}

function journalMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte))) return Buffer.from(value).toString('utf8');
  return '';
}

export function parseJournalJsonLine(line: string): JournalLine | null {
  try {
    const parsed = JSON.parse(line);
    const timestampUs = Number(parsed.__REALTIME_TIMESTAMP);
    const message = journalMessage(parsed.MESSAGE);
    if (!Number.isFinite(timestampUs) || !message) return null;
    return { realtimeTimestamp: new Date(Math.floor(timestampUs / 1000)).toISOString(), message };
  } catch {
    return null;
  }
}

export function buildNineRouterLogSummary(lines: JournalLine[], options: BuildSummaryOptions): TrafficSummary {
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = options.windowMinutes * 60_000;
  const bucketMs = options.bucketMinutes * 60_000;
  const minMs = nowMs - windowMs;
  const buckets = new Map<number, Bucket>();
  const models = new Map<string, ModelStats>();
  let latestEventMs = 0;

  for (const line of lines) {
    const atMs = Date.parse(line.realtimeTimestamp);
    if (!Number.isFinite(atMs) || atMs < minMs || atMs > nowMs + 60_000) continue;
    const event = parseNineRouterLogLine(line.message);
    if (!event) continue;
    const bucketStartMs = Math.floor(atMs / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStartMs) ?? newBucket(bucketStartMs);
    buckets.set(bucketStartMs, bucket);
    latestEventMs = Math.max(latestEventMs, atMs);
    bucket.latestEventMs = Math.max(bucket.latestEventMs, atMs);

    const model = normalizeModel(event.model);
    const modelStats = models.get(model) ?? newModelStats();
    models.set(model, modelStats);

    if (event.kind === 'request') {
      bucket.requestCount += 1;
      modelStats.requestCount += 1;
    } else {
      bucket.streamCount += 1;
      modelStats.streamCount += 1;
      addLatency(bucket.upstreamMs, event.durationMs);
      addLatency(modelStats.upstreamMs, event.durationMs);
      if (event.status !== 'complete') {
        bucket.errorCount += 1;
        modelStats.errorCount += 1;
      }
    }
  }

  const selectedBuckets = [...buckets.values()].sort((a, b) => a.bucketStartMs - b.bucketStartMs);
  const requestCount = selectedBuckets.reduce((sum, bucket) => sum + bucket.requestCount, 0);
  const streamCount = selectedBuckets.reduce((sum, bucket) => sum + bucket.streamCount, 0);
  const errorCount = selectedBuckets.reduce((sum, bucket) => sum + bucket.errorCount, 0);
  const upstreamMs = selectedBuckets.reduce((acc, bucket) => ({ sum: acc.sum + bucket.upstreamMs.sum, max: Math.max(acc.max, bucket.upstreamMs.max) }), emptyLatency());

  return {
    source: '9router-journal',
    windowMinutes: options.windowMinutes,
    bucketMinutes: options.bucketMinutes,
    generatedAt: new Date(nowMs).toISOString(),
    latestEventAt: latestEventMs ? new Date(latestEventMs).toISOString() : null,
    requestCount,
    streamCount,
    errorCount,
    timeoutCount: errorCount,
    largeContextCount: 0,
    bodyBytes: 0,
    estimatedInputTokens: 0,
    queuedMs: { avg: 0, max: 0 },
    upstreamMs: latencySummary(upstreamMs, streamCount),
    totalMs: latencySummary(upstreamMs, streamCount),
    buckets: selectedBuckets.map(bucket => ({
      bucketStart: new Date(bucket.bucketStartMs).toISOString(),
      requestCount: bucket.requestCount,
      streamCount: bucket.streamCount,
      errorCount: bucket.errorCount,
      timeoutCount: bucket.errorCount,
      largeContextCount: 0,
      avgQueuedMs: 0,
      avgUpstreamMs: latencySummary(bucket.upstreamMs, bucket.streamCount).avg,
      avgTotalMs: latencySummary(bucket.upstreamMs, bucket.streamCount).avg,
      maxUpstreamMs: bucket.upstreamMs.max,
    })),
    models: [...models.entries()].map(([model, stats]) => ({
      model,
      requestCount: stats.requestCount,
      streamCount: stats.streamCount,
      errorCount: stats.errorCount,
      avgUpstreamMs: latencySummary(stats.upstreamMs, stats.streamCount).avg,
      maxUpstreamMs: stats.upstreamMs.max,
    })).sort((a, b) => (b.streamCount + b.requestCount) - (a.streamCount + a.requestCount) || b.maxUpstreamMs - a.maxUpstreamMs).slice(0, 10),
  };
}

export async function readNineRouterJournalLines(since: string): Promise<JournalLine[]> {
  const { stdout } = await execFileAsync('journalctl', nineRouterJournalArgs(since), { maxBuffer: 20 * 1024 * 1024 });
  return stdout.split('\n').map(parseJournalJsonLine).filter((line): line is JournalLine => Boolean(line));
}

export function createNineRouterLogMetricsSampler(options = { windowMinutes: 120, bucketMinutes: 5, refreshMs: 5 * 60_000 }) {
  let current = buildNineRouterLogSummary([], { windowMinutes: options.windowMinutes, bucketMinutes: options.bucketMinutes });
  let lastError: string | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;

  async function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const lines = await readNineRouterJournalLines(`${options.windowMinutes + options.bucketMinutes} minutes ago`);
        current = buildNineRouterLogSummary(lines, { windowMinutes: options.windowMinutes, bucketMinutes: options.bucketMinutes });
        lastError = null;
      } catch (err: any) {
        lastError = err?.message ?? String(err);
        current = { ...current, generatedAt: new Date().toISOString(), error: lastError };
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  function start() {
    void refresh();
    timer = setInterval(() => void refresh(), options.refreshMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  function summary() {
    return lastError ? { ...current, error: lastError } : current;
  }

  return { refresh, start, stop, summary };
}

export const nineRouterLogMetrics = createNineRouterLogMetricsSampler();
