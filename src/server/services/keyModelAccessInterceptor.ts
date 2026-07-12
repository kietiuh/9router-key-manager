import type Database from 'better-sqlite3';
import type { FastifyLoggerInstance } from 'fastify';
import { extractBearerToken } from './quotaInterceptor.js';

export type KeyModelAccessLookupResult = {
  id: string;
};

export type KeyModelAccessLookup = (token: string) => KeyModelAccessLookupResult | undefined;

export type KeyModelAccessLogger = Pick<FastifyLoggerInstance, 'warn' | 'info' | 'error' | 'debug'>;

export type KeyModelAccessInterceptResult = {
  blocked: true;
  status: 403;
  code: 'model_not_allowed';
  keyId: string;
  model: string;
  allowedModels: string[];
} | {
  blocked: false;
};

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function readAllowedModels(
  db: Database.Database,
  keyId: string,
  logger?: KeyModelAccessLogger,
): string[] {
  const row = db.prepare('SELECT allowed_models_json FROM key_policies WHERE key_id = ?').get(keyId) as { allowed_models_json?: string | null } | undefined;
  const raw = row?.allowed_models_json;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn({ keyId, reason: 'malformed_whitelist_json' }, 'key policy whitelist unparseable; treating as full access');
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger?.warn({ keyId, reason: 'malformed_whitelist_json' }, 'key policy whitelist unparseable; treating as full access');
    return [];
  }
  return normalizeList(parsed);
}

export function evaluateKeyModelAccessInterceptor(opts: {
  db: Database.Database;
  authHeader: string | string[] | undefined;
  rawModel: string | undefined;
  lookupKey: KeyModelAccessLookup;
  log?: KeyModelAccessLogger;
}): KeyModelAccessInterceptResult {
  const token = extractBearerToken(opts.authHeader);
  if (!token) return { blocked: false };
  const key = opts.lookupKey(token);
  if (!key) return { blocked: false };
  const model = typeof opts.rawModel === 'string' ? opts.rawModel : '';
  if (!model) return { blocked: false };
  const allowedModels = readAllowedModels(opts.db, key.id, opts.log);
  if (!allowedModels.length) return { blocked: false };
  if (allowedModels.includes(model)) return { blocked: false };
  return {
    blocked: true,
    status: 403,
    code: 'model_not_allowed',
    keyId: key.id,
    model,
    allowedModels,
  };
}

export function buildKeyModelNotAllowedErrorBody(result: Extract<KeyModelAccessInterceptResult, { blocked: true }>) {
  return {
    error: {
      message: `Model '${result.model}' is not allowed for this API key.`,
      type: 'permission_denied',
      code: 'model_not_allowed',
      model: result.model,
      allowed_models: result.allowedModels,
    },
  };
}
