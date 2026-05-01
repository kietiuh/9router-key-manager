import fs from 'node:fs';
import { z } from 'zod';
import type { ApiKeyRecord, UsageRecord } from '../../shared/types.js';
import { dbJsonPath, usageJsonPath } from './paths.js';

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

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

export function readApiKeys(baseDir?: string): ApiKeyRecord[] {
  return DbSchema.parse(readJson(dbJsonPath(baseDir))).apiKeys;
}

export function readUsageHistory(baseDir?: string): UsageRecord[] {
  return UsageSchema.parse(readJson(usageJsonPath(baseDir))).history;
}
