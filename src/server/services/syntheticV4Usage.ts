import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordSyntheticUsage } from './usageStore.js';

const TARGET_MODEL = 'v4/gpt-5.5';
const MIN_TOKENS = 50_000;
const MAX_TOKENS = 100_000;

export type SyntheticV4UsageResult =
  | { recorded: true; signature: string; totalTokens: number; promptTokens: number; completionTokens: number }
  | { recorded: false; reason: 'model_not_targeted' | 'upstream_not_successful' | 'missing_api_key' | 'missing_key_id' };

export type SyntheticV4UsageArgs = {
  apiKey: string;
  keyId: string;
  requestId: string;
  model: string;
  upstreamStatus: number;
  timestamp: string;
  estimatedInputTokens: number;
  randomInt?: (min: number, maxExclusive: number) => number;
};

function randomTotalTokens(args: Pick<SyntheticV4UsageArgs, 'randomInt'>): number {
  const pick = Math.trunc((args.randomInt ?? crypto.randomInt)(MIN_TOKENS, MAX_TOKENS + 1));
  return Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, pick));
}

export function recordSyntheticV4Usage(db: Database.Database, args: SyntheticV4UsageArgs): SyntheticV4UsageResult {
  if (args.model !== TARGET_MODEL) return { recorded: false, reason: 'model_not_targeted' };
  if (args.upstreamStatus < 200 || args.upstreamStatus >= 300) return { recorded: false, reason: 'upstream_not_successful' };
  const apiKey = args.apiKey.trim();
  if (!apiKey) return { recorded: false, reason: 'missing_api_key' };
  if (!args.keyId.trim()) return { recorded: false, reason: 'missing_key_id' };

  const totalTokens = randomTotalTokens(args);
  const promptTokens = Math.min(Math.max(0, Math.trunc(args.estimatedInputTokens || 0)), totalTokens);
  const completionTokens = totalTokens - promptTokens;
  const signature = ['synthetic-v4', args.keyId, args.requestId, args.timestamp, args.model].join('|');

  recordSyntheticUsage(db, {
    signature,
    apiKey,
    model: args.model,
    timestamp: args.timestamp,
    provider: 'key-manager-synthetic',
    connectionId: 'v4-success',
    tokens: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    keyId: args.keyId,
    requestId: args.requestId,
    upstreamStatus: args.upstreamStatus,
    estimatedInputTokens: args.estimatedInputTokens,
  } as any);

  return { recorded: true, signature, totalTokens, promptTokens, completionTokens };
}
