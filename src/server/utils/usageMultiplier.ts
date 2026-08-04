import { Transform } from 'node:stream';
import type Database from 'better-sqlite3';
import { multiplierAt } from '../services/usage.js';

// Flat token fields common to OpenAI and Anthropic usage blocks.
const FLAT_TOKEN_FIELDS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_tokens',
  // Anthropic aliases for prompt/completion.
  'input_tokens',
  'output_tokens',
] as const;

// OpenAI-style nested token details inside `usage`. Both chat/completions
// (prompt_/completion_tokens_details) and the newer Responses API
// (input_/output_tokens_details) use the same shape, so we scale both.
const NESTED_TOKEN_FIELDS = [
  { parent: 'prompt_tokens_details', child: 'cached_tokens' },
  { parent: 'completion_tokens_details', child: 'reasoning_tokens' },
  { parent: 'input_tokens_details', child: 'cached_tokens' },
  { parent: 'output_tokens_details', child: 'reasoning_tokens' },
] as const;

function scaleValue(value: unknown, factor: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(value * factor);
}

/**
 * In-place mutation: scale token counts inside a usage object (OpenAI/Anthropic
 * compatible). Mutates and returns the same reference for ergonomics; safe to
 * call multiple times (idempotent because we always overwrite the same field).
 *
 * Skips non-object input and non-numeric / non-finite field values.
 *
 * Covers:
 *   - OpenAI chat/completions flat + nested details
 *   - OpenAI Responses API (/v1/responses) flat + nested details
 *   - Anthropic Messages API flat fields
 */
export function applyUsageMultiplierToUsage(usage: unknown, factor: number): unknown {
  if (!usage || typeof usage !== 'object') return usage;
  const obj = usage as Record<string, unknown>;

  for (const key of FLAT_TOKEN_FIELDS) {
    const next = scaleValue(obj[key], factor);
    if (next !== undefined) obj[key] = next;
  }

  for (const { parent, child } of NESTED_TOKEN_FIELDS) {
    const nested = obj[parent];
    if (!nested || typeof nested !== 'object') continue;
    const nestedObj = nested as Record<string, unknown>;
    const next = scaleValue(nestedObj[child], factor);
    if (next !== undefined) nestedObj[child] = next;
  }

  return obj;
}

export type ResolvedMultiplier = {
  factor: number;
  events: Array<{ multiplier: number; effective_at: string }>;
};

/**
 * Resolve the effective usage_multiplier for an API key at a given timestamp.
 * Returns factor=1 when:
 *   - key has no policy / no events / no effective event yet
 *   - resolved factor is 0 or negative (treated as identity per spec)
 */
export function resolveMultiplierForKey(db: Database.Database, keyId: string, nowIso?: string): ResolvedMultiplier {
  const events = db.prepare(
    'SELECT multiplier, effective_at FROM usage_multiplier_events WHERE key_id = ? ORDER BY effective_at ASC, id ASC'
  ).all(keyId) as Array<{ multiplier: number; effective_at: string }>;

  let effectiveEvents: Array<{ multiplier: number; effective_at: string }> = events.map(e => ({
    multiplier: Number(e.multiplier),
    effective_at: e.effective_at,
  }));

  if (effectiveEvents.length === 0) {
    const row = db.prepare('SELECT usage_multiplier, usage_multiplier_effective_at FROM key_policies WHERE key_id = ?').get(keyId) as
      | { usage_multiplier?: number | null; usage_multiplier_effective_at?: string | null }
      | undefined;
    if (row?.usage_multiplier_effective_at) {
      effectiveEvents = [{
        multiplier: Number(row.usage_multiplier ?? 1),
        effective_at: row.usage_multiplier_effective_at,
      }];
    }
  }

  const resolvedAt = nowIso ?? new Date().toISOString();
  const rawFactor = multiplierAt(resolvedAt, effectiveEvents);
  // Per spec: factor <= 0 (or factor === 1) collapses to 1 so caller can skip.
  const factor = !Number.isFinite(rawFactor) || rawFactor <= 0 || rawFactor === 1 ? 1 : rawFactor;

  return { factor, events: effectiveEvents };
}

const SSE_BOUNDARY = /\r?\n\r?\n/g;

/**
 * Build a Transform stream that parses SSE events from upstream (text/event-stream)
 * and scales `usage` in any JSON `data:` event by `factor`. Non-JSON events,
 * `[DONE]` markers, and `event:`/`id:`/`retry:`/comment lines pass through
 * verbatim. SSE framing is preserved byte-for-byte (re-emits `\n\n` boundary).
 *
 * `factor === 1` callers should NOT wrap the stream - skip entirely.
 */
export function createUsageScalingSseTransform(factor: number): Transform {
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(SSE_BOUNDARY);
      // Last element is the trailing partial (possibly empty). Keep buffering.
      buffer = parts.pop() ?? '';
      if (parts.length === 0) return callback();
      const out = parts.map(processEvent).join('');
      callback(null, Buffer.from(out, 'utf-8'));
    },
    flush(callback) {
      // Flush any trailing decoder state (handles multi-byte UTF-8 split across chunk boundary).
      buffer += decoder.decode();
      const trailing = buffer ? processEvent(buffer) : '';
      buffer = '';
      callback(null, trailing ? Buffer.from(trailing, 'utf-8') : null);
    },
  });

  function processEvent(eventText: string): string {
    if (!eventText) return '';
    const lines = eventText.split(/\r?\n/);
    const dataLines: string[] = [];
    const otherLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line);
      else otherLines.push(line);
    }
    if (dataLines.length === 0) {
      // No data lines (e.g. comments-only or unknown framing) - pass through verbatim
      // with the original event boundary re-attached.
      return eventText + '\n\n';
    }
    // Combine multiple `data:` lines per SSE spec (each contributes one line, joined by \n).
    const dataPayload = dataLines.map(l => l.slice(5).trimStart()).join('\n');
    // Pass through verbatim if not JSON (e.g. `data: [DONE]`, comments).
    if (!dataPayload.startsWith('{') && !dataPayload.startsWith('[')) {
      return eventText + '\n\n';
    }
    let parsed: any;
    try {
      parsed = JSON.parse(dataPayload);
    } catch {
      return eventText + '\n\n';
    }
    let mutated = false;
    if (parsed && typeof parsed === 'object') {
      if (parsed.usage && typeof parsed.usage === 'object') {
        applyUsageMultiplierToUsage(parsed.usage, factor);
        mutated = true;
      }
      if (parsed.message && typeof parsed.message === 'object' && parsed.message.usage && typeof parsed.message.usage === 'object') {
        applyUsageMultiplierToUsage(parsed.message.usage, factor);
        mutated = true;
      }
      // OpenAI Responses API streaming events: usage lives under
      // `event.response.usage` (e.g. response.completed).
      if (parsed.response && typeof parsed.response === 'object' && parsed.response.usage && typeof parsed.response.usage === 'object') {
        applyUsageMultiplierToUsage(parsed.response.usage, factor);
        mutated = true;
      }
    }
    if (!mutated) return eventText + '\n\n';
    const newData = JSON.stringify(parsed);
    const otherBlock = otherLines.length ? otherLines.join('\n') + '\n' : '';
    return `${otherBlock}data: ${newData}\n\n`;
  }
}