import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { ApiKeyRecord, UsageRecord } from '../../shared/types.js';
import { dataSqlitePath, dbJsonPath, usageJsonPath } from './paths.js';

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  machineId: z.string().optional(),
  isActive: z.boolean().default(true),
  createdAt: z.string().optional()
});

const DbSchema = z.object({ apiKeys: z.array(ApiKeySchema).default([]) }).passthrough();
const UsageRecordSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  timestamp: z.string(),
  cost: z.number().optional(),
  tokens: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional()
  }).optional()
}).passthrough();
const UsageSchema = z.object({ history: z.array(UsageRecordSchema).default([]) }).passthrough();

function readJson(pathname: string): unknown { return JSON.parse(fs.readFileSync(pathname, 'utf8')); }
function fileExists(pathname: string): boolean { try { return fs.existsSync(pathname); } catch { return false; } }

function readSqliteApiKeys(pathname: string): ApiKeyRecord[] | null {
  if (!fileExists(pathname)) return null;
  try {
    const db = new Database(pathname, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, name, key, machineId, isActive, createdAt FROM apiKeys ORDER BY name ASC').all() as any[];
      return rows.map(row => ApiKeySchema.parse({
        id: String(row.id),
        name: String(row.name ?? row.id),
        key: String(row.key),
        machineId: row.machineId ?? undefined,
        isActive: row.isActive === 1 || row.isActive === true || row.isActive === 'true',
        createdAt: row.createdAt ?? undefined
      }));
    } finally { db.close(); }
  } catch { return null; }
}

function parseTokens(raw: unknown, promptTokens?: number, completionTokens?: number): UsageRecord['tokens'] {
  let parsed: any = {};
  if (typeof raw === 'string' && raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  } else if (raw && typeof raw === 'object') parsed = raw;
  const prompt = Number(parsed.prompt_tokens ?? promptTokens ?? 0);
  const completion = Number(parsed.completion_tokens ?? completionTokens ?? 0);
  const total = parsed.total_tokens == null ? undefined : Number(parsed.total_tokens);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: total !== undefined && Number.isFinite(total) ? total : undefined,
    cache_read_input_tokens: parsed.cache_read_input_tokens == null ? undefined : Number(parsed.cache_read_input_tokens),
    cache_creation_input_tokens: parsed.cache_creation_input_tokens == null ? undefined : Number(parsed.cache_creation_input_tokens),
    reasoning_tokens: parsed.reasoning_tokens == null ? undefined : Number(parsed.reasoning_tokens)
  };
}

function readSqliteUsageHistory(pathname: string): UsageRecord[] | null {
  if (!fileExists(pathname)) return null;
  try {
    const db = new Database(pathname, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY timestamp ASC, id ASC`).all() as any[];
      return rows.map(row => UsageRecordSchema.parse({
        apiKey: row.apiKey ?? undefined,
        model: row.model ?? undefined,
        timestamp: String(row.timestamp),
        cost: row.cost == null ? undefined : Number(row.cost),
        provider: row.provider ?? undefined,
        connectionId: row.connectionId ?? undefined,
        endpoint: row.endpoint ?? undefined,
        status: row.status ?? undefined,
        tokens: parseTokens(row.tokens, row.promptTokens, row.completionTokens)
      }));
    } finally { db.close(); }
  } catch { return null; }
}

export function readApiKeys(baseDir?: string): ApiKeyRecord[] {
  const sqliteRows = readSqliteApiKeys(dataSqlitePath(baseDir));
  if (sqliteRows) return sqliteRows;
  return DbSchema.parse(readJson(dbJsonPath(baseDir))).apiKeys;
}

export function readUsageHistory(baseDir?: string): UsageRecord[] {
  const sqliteRows = readSqliteUsageHistory(dataSqlitePath(baseDir));
  if (sqliteRows) return sqliteRows;
  return UsageSchema.parse(readJson(usageJsonPath(baseDir))).history;
}

export function usageSourceStatus(baseDir?: string) {
  const sqlitePath = dataSqlitePath(baseDir);
  const hasSqlite = fileExists(sqlitePath);
  if (hasSqlite) return { usageSource: 'sqlite', dataSqlitePath: sqlitePath, dataSqliteExists: true } as const;
  return { usageSource: 'json', dataSqlitePath: sqlitePath, dataSqliteExists: false } as const;
}
