import { describe, expect, it } from 'vitest';
import { buildNineRouterLogSummary, nineRouterJournalArgs, parseJournalJsonLine, parseNineRouterLogLine } from './nineRouterLogMetrics.js';

describe('nineRouterLogMetrics', () => {
  it('parses request and stream completion lines from 9router logs', () => {
    expect(parseNineRouterLogLine('[12:24:48] 📥 POST /v1/responses | v1/cx/gpt-5.5 | 184 msgs | 10 tools')).toMatchObject({ kind: 'request', path: '/v1/responses', model: 'v1/cx/gpt-5.5' });
    expect(parseNineRouterLogLine('[12:24:38] 🌊 [STREAM] OPENAI-COMPATIBLE | cx/gpt-5.5 | 36058ms | complete')).toMatchObject({ kind: 'stream', model: 'cx/gpt-5.5', durationMs: 36058, status: 'complete' });
    expect(parseNineRouterLogLine('[12:25:05] 🌊 [STREAM] OPENAI-COMPATIBLE | cx/gpt-5.5 | 16900ms | disconnect: ResponseAborted')).toMatchObject({ kind: 'stream', model: 'cx/gpt-5.5', durationMs: 16900, status: 'aborted' });
  });

  it('aggregates the last two hours using journal timestamps', () => {
    const lines = [
      { realtimeTimestamp: '2026-05-27T10:00:00.000Z', message: '[10:00:00] 📥 POST /v1/responses | v1/cx/gpt-5.5 | 10 msgs | 1 tools' },
      { realtimeTimestamp: '2026-05-27T10:00:30.000Z', message: '[10:00:30] 🌊 [STREAM] PROVIDER | cx/gpt-5.5 | 30000ms | complete' },
      { realtimeTimestamp: '2026-05-27T10:05:00.000Z', message: '[10:05:00] 📥 POST /v1/chat/completions | v1/cx/gpt-5.5 | 11 msgs | 0 tools' },
      { realtimeTimestamp: '2026-05-27T10:05:20.000Z', message: '[10:05:20] 🌊 [STREAM] PROVIDER | cx/gpt-5.5 | 20000ms | disconnect: ResponseAborted' },
      { realtimeTimestamp: '2026-05-27T07:55:00.000Z', message: '[07:55:00] 📥 POST /v1/responses | old-model | 1 msgs | 0 tools' },
    ];

    const summary = buildNineRouterLogSummary(lines, { nowMs: Date.parse('2026-05-27T10:10:00.000Z'), windowMinutes: 120, bucketMinutes: 5 });

    expect(summary.source).toBe('9router-journal');
    expect(summary.requestCount).toBe(2);
    expect(summary.streamCount).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(summary.latestEventAt).toBe('2026-05-27T10:05:20.000Z');
    expect(summary.upstreamMs.avg).toBe(25000);
    expect(summary.upstreamMs.max).toBe(30000);
    expect(summary.models[0]).toMatchObject({ model: 'cx/gpt-5.5', requestCount: 2, streamCount: 2, errorCount: 1 });
    expect(summary.buckets).toHaveLength(2);
  });

  it('decodes byte-array journal MESSAGE fields used by colored request lines', () => {
    const raw = JSON.stringify({ __REALTIME_TIMESTAMP: '1779886537465975', MESSAGE: [...Buffer.from('\u001b[36m[12:55:37] 📥 POST /v1/responses | v3/gpt-5.5 | 18 msgs\u001b[0m')] });

    const parsed = parseJournalJsonLine(raw);

    expect(parsed?.realtimeTimestamp).toBe('2026-05-27T12:55:37.465Z');
    expect(parseNineRouterLogLine(parsed?.message ?? '')).toMatchObject({ kind: 'request', path: '/v1/responses', model: 'v3/gpt-5.5' });
  });

  it('normalizes request aliases to the same model names used by stream logs', () => {
    const lines = [
      { realtimeTimestamp: '2026-05-27T10:00:00.000Z', message: '[10:00:00] 📥 POST /v1/responses | v1/cx/gpt-5.5 | 10 msgs | 1 tools' },
      { realtimeTimestamp: '2026-05-27T10:00:20.000Z', message: '[10:00:20] 🌊 [STREAM] PROVIDER | cx/gpt-5.5 | 20000ms | complete' },
      { realtimeTimestamp: '2026-05-27T10:01:00.000Z', message: '[10:01:00] 📥 POST /v1/responses | v3/gpt-5.5 | 1 msgs | 1 tools' },
      { realtimeTimestamp: '2026-05-27T10:01:30.000Z', message: '[10:01:30] 🌊 [STREAM] PROVIDER | gpt-5.5 | 30000ms | complete' },
    ];

    const summary = buildNineRouterLogSummary(lines, { nowMs: Date.parse('2026-05-27T10:05:00.000Z'), windowMinutes: 120, bucketMinutes: 5 });

    expect(summary.models).toHaveLength(2);
    expect(summary.models.find(model => model.model === 'cx/gpt-5.5')).toMatchObject({ requestCount: 1, streamCount: 1 });
    expect(summary.models.find(model => model.model === 'gpt-5.5')).toMatchObject({ requestCount: 1, streamCount: 1 });
  });

  it('bounds journal reads to avoid buffering oversized service logs', () => {
    expect(nineRouterJournalArgs('125 minutes ago')).toContain('-n');
    expect(nineRouterJournalArgs('125 minutes ago')).toContain('2000');
  });
});
