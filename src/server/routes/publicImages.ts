import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { imageProxyNeedsServerKey } from '../../shared/imageProxy.js';
import { buildImageProxyUrl, getImageProxyConfig } from '../services/imageProxy.js';
import { createPublicImageJobQueue, type PublicImageResult } from '../services/publicImageJobs.js';
import { enhanceImagePrompt } from '../services/publicImage.js';
import type { PublicImageStore } from '../services/publicImageStore.js';
import { recordSyntheticUsage } from '../services/usageStore.js';

export type PublicImageRouteKey = {
  id: string;
  key: string;
};

export type PublicImageRouteOptions = {
  db: Database.Database;
  findPublicKey: (key: string) => PublicImageRouteKey | undefined;
  nineRouterUpstream: string;
  publicImageStore: PublicImageStore;
  queue: {
    maxGlobal: number;
    maxPerKey: number;
    ttlMs: number;
  };
  serverImageProxyKey: () => string | undefined;
  fetch?: typeof fetch;
};

const PublicImageOptimizeBody = z.object({ key: z.string().min(8), prompt: z.string().min(3).max(6000) });
const PublicImageGenerateBody = z.object({ key: z.string().min(8), prompt: z.string().min(3).max(6000), size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional() });
const PublicImageHistoryBody = z.object({ key: z.string().min(8) });
const PublicImageDownloadBody = z.object({ key: z.string().min(8), id: z.number().int().positive() });
const PublicImageJobBody = PublicImageGenerateBody;
const PublicImageJobStatusBody = z.object({ key: z.string().min(8), jobId: z.string().uuid() });

function sanitizeImagePrompt(prompt: string) {
  // eslint-disable-next-line no-control-regex
  return prompt.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
}

function guardImagePrompt(prompt: string) {
  const text = sanitizeImagePrompt(prompt);
  const lower = text.toLowerCase();
  const blocked = [/child\s*(sexual|nude|porn|explicit)/i, /loli|shota/i, /underage.*(nude|sex|porn)/i, /realistic\s+gore/i, /blood\s+and\s+guts/i];
  if (!text) throw new Error('Prompt is empty');
  if (blocked.some(rx => rx.test(lower))) throw new Error('Prompt is not allowed');
  return text;
}

function fallbackOptimizedPrompt(prompt: string) {
  const clean = guardImagePrompt(prompt);
  return enhanceImagePrompt(clean);
}

function extractChatContent(json: unknown) {
  const data = json as { choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>; output_text?: unknown };
  return String(data?.choices?.[0]?.message?.content ?? data?.output_text ?? '').trim();
}

function extractChatStreamContent(text: string) {
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      out += JSON.parse(data)?.choices?.[0]?.delta?.content ?? '';
    } catch {
      // Ignore malformed SSE chunks and keep reading the stream.
    }
  }
  return out.trim();
}

function extractImageBase64(json: unknown) {
  const data = json as { data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown; revisedPrompt?: unknown }> };
  const item = data?.data?.[0];
  const revisedPrompt = typeof item?.revised_prompt === 'string'
    ? item.revised_prompt
    : typeof item?.revisedPrompt === 'string'
      ? item.revisedPrompt
      : undefined;
  if (typeof item?.b64_json === 'string') return { image: item.b64_json, revisedPrompt };
  if (typeof item?.url === 'string' && item.url.startsWith('data:image/')) return { image: item.url.split(',').pop() || '', revisedPrompt };
  return { image: '', revisedPrompt: undefined };
}

function publicImageFilename() {
  return `gocinema-image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(text || '', 'utf8') / 4));
}

function estimateImageTokens(size: string, imageCount = 1) {
  const base = size === '1024x1536' || size === '1536x1024' ? 30000 : 20000;
  return base * imageCount;
}

function recordKeyImageTokenUsage(db: Database.Database, args: { key: string; keyId: string; kind: string; model: string; promptTokens: number; completionTokens: number; timestamp?: string; sourceId: string }) {
  const timestamp = args.timestamp ?? new Date().toISOString();
  const total = args.promptTokens + args.completionTokens;
  const signature = `synthetic-image|${args.kind}|${args.keyId}|${args.model}|${args.sourceId}`;
  recordSyntheticUsage(db, { signature, apiKey: args.key, model: args.model, timestamp, provider: 'image-proxy', connectionId: args.kind, tokens: { prompt_tokens: args.promptTokens, completion_tokens: args.completionTokens, total_tokens: total } } as any);
  return { signature, total };
}

export async function registerPublicImageRoutes(app: FastifyInstance, options: PublicImageRouteOptions) {
  const fetchFn = options.fetch ?? fetch;
  const {
    db,
    findPublicKey,
    nineRouterUpstream,
    publicImageStore,
    queue,
    serverImageProxyKey,
  } = options;

  async function runPublicImageGeneration(match: PublicImageRouteKey, prompt: string, size: string): Promise<PublicImageResult> {
    publicImageStore.ensureImageDailyQuota(match.id);
    const imageProxyConfig = getImageProxyConfig(db);
    if (!imageProxyConfig.enabled) throw new Error('image proxy disabled');
    const upstreamHeaders: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${match.key}` };
    if (imageProxyNeedsServerKey(imageProxyConfig)) {
      const serverKey = serverImageProxyKey();
      if (!serverKey) throw new Error('image service not configured');
      upstreamHeaders.authorization = `Bearer ${serverKey}`;
    }
    const imageModel = imageProxyConfig.modelOverride?.trim() || 'cx/gpt-5.4-image';
    const payload = { model: imageModel, prompt: fallbackOptimizedPrompt(prompt), size, n: 1 };
    const started = Date.now();
    const upstream = await fetchFn(buildImageProxyUrl(imageProxyConfig, '/v1/images/generations'), { method: 'POST', headers: upstreamHeaders, body: JSON.stringify(payload) });
    const json = await upstream.json().catch(() => ({}));
    const { image, revisedPrompt } = extractImageBase64(json);
    if (!upstream.ok || !image) {
      publicImageStore.recordImageProxyUsage({ keyId: match.id, apiKey: match.key, kind: 'public-page', model: imageModel, size, promptPreview: prompt.slice(0, 160), status: 'error', error: (json as any)?.error?.message || `upstream ${upstream.status}`, imageCount: 1 });
      throw new Error((json as any)?.error?.message || 'image generation failed');
    }
    const bytes = Buffer.byteLength(image, 'base64');
    const stored = publicImageStore.savePublicImage(image);
    const promptTokens = estimateTokens(payload.prompt);
    const completionTokens = estimateImageTokens(size, 1);
    const usage = recordKeyImageTokenUsage(db, { key: match.key, keyId: match.id, kind: 'public-image-generate', model: imageModel, promptTokens, completionTokens, sourceId: crypto.createHash('sha256').update(`${match.id}|${payload.prompt}|${size}|${started}`).digest('hex').slice(0, 16) });
    publicImageStore.recordImageProxyUsage({ keyId: match.id, apiKey: match.key, kind: 'public-page', model: imageModel, size, promptPreview: prompt.slice(0, 160), promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16), outputFile: stored.fileName, status: 'success', imageCount: 1, bytes, estimatedPromptTokens: promptTokens, estimatedCompletionTokens: completionTokens, estimatedTotalTokens: usage.total, usageEventSignature: usage.signature, expiresAt: stored.expiresAt });
    app.log.info({ keyId: match.id, model: imageModel, size, bytes, estimatedTokens: usage.total, totalMs: Date.now() - started }, 'public image generated');
    return { image, mimeType: 'image/png', filename: publicImageFilename(), revisedPrompt, prompt: payload.prompt, bytes, expiresAt: stored.expiresAt };
  }

  const publicImageJobs = createPublicImageJobQueue({
    maxGlobal: queue.maxGlobal,
    maxPerKey: queue.maxPerKey,
    ttlMs: queue.ttlMs,
    generate: job => runPublicImageGeneration({ id: job.keyId, key: job.key }, job.prompt, job.size),
  });

  app.post('/api/public/images/optimize-prompt', async (req, reply) => {
    const body = PublicImageOptimizeBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    const prompt = guardImagePrompt(body.prompt);
    const system = 'Rewrite image prompts for a text-to-image model. Return only the improved prompt in English. Keep user intent. Add concise visual details: subject, composition, lighting, style, quality. Avoid unsafe sexual minors, gore, hate, private data, text/watermarks.';
    try {
      const upstream = await fetchFn(`${nineRouterUpstream}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${match.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'v1/cx/gpt-5.5', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: true, max_tokens: 500 }),
      });
      const text = await upstream.text();
      let optimized = extractChatStreamContent(text);
      if (!optimized) {
        try {
          optimized = extractChatContent(JSON.parse(text));
        } catch {
          // Non-JSON fallback below.
        }
      }
      optimized = sanitizeImagePrompt(optimized);
      if (upstream.ok && optimized) {
        const finalPrompt = guardImagePrompt(optimized);
        const promptTokens = estimateTokens(`${system}\n${prompt}`);
        const completionTokens = estimateTokens(finalPrompt);
        const usage = recordKeyImageTokenUsage(db, { key: match.key, keyId: match.id, kind: 'public-image-optimize', model: 'v1/cx/gpt-5.5', promptTokens, completionTokens, sourceId: crypto.createHash('sha256').update(`${match.id}|${prompt}|${finalPrompt}|${Date.now()}`).digest('hex').slice(0, 16) });
        publicImageStore.recordImageProxyUsage({ keyId: match.id, apiKey: match.key, kind: 'public-image-optimize', model: 'v1/cx/gpt-5.5', promptPreview: prompt.slice(0, 160), promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16), status: 'success', imageCount: 1, estimatedPromptTokens: promptTokens, estimatedCompletionTokens: completionTokens, estimatedTotalTokens: usage.total, usageEventSignature: usage.signature });
        return { prompt: finalPrompt, source: 'optimized' };
      }
    } catch {
      // Keep the public page usable when prompt optimization is unavailable.
    }
    return { prompt: fallbackOptimizedPrompt(prompt), source: 'fallback' };
  });

  app.post('/api/public/images/jobs', async (req, reply) => {
    const body = PublicImageJobBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    return publicImageJobs.createJob(match, guardImagePrompt(body.prompt), body.size ?? '1024x1024');
  });

  app.post('/api/public/images/jobs/status', async (req, reply) => {
    const body = PublicImageJobStatusBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    const job = publicImageJobs.getJob(body.jobId, match.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });

  app.post('/api/public/images/jobs/cancel', async (req, reply) => {
    const body = PublicImageJobStatusBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    try {
      const job = publicImageJobs.cancelJob(body.jobId, match.id);
      if (!job) return reply.code(404).send({ error: 'job not found' });
      return job;
    } catch {
      return reply.code(409).send({ error: 'image generation already started' });
    }
  });

  app.post('/api/public/images/generate', async (req, reply) => {
    const body = PublicImageGenerateBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    const created = publicImageJobs.createJob(match, guardImagePrompt(body.prompt), body.size ?? '1024x1024');
    try {
      const job = await publicImageJobs.waitForJob(created.jobId);
      if (job.status === 'success' && job.result) return job.result;
      return reply.code(job.status === 'cancelled' ? 409 : 502).send({ error: job.error || job.status });
    } catch (err: any) {
      return reply.code(202).send({ ...created, error: err?.message || 'image generation queued' });
    }
  });

  app.post('/api/public/images/history', async (req, reply) => {
    const body = PublicImageHistoryBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    return publicImageStore.imageHistoryForKey(match.id);
  });

  app.post('/api/public/images/download', async (req, reply) => {
    const body = PublicImageDownloadBody.parse(req.body);
    const match = findPublicKey(body.key);
    if (!match) return reply.code(401).send({ error: 'invalid key' });
    const image = publicImageStore.readPublicImageForKey(body.id, match.id);
    if (!image) return reply.code(404).send({ error: 'image not found or expired' });
    return image;
  });
}
