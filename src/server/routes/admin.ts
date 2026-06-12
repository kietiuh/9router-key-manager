import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClientRateLimitConfig, FinalFallbackConfig, ModelRateLimitConfig } from '../../shared/types.js';
import { buildConfigStatus } from '../configStatus.js';
import { getModelRewriteConfig, saveModelRewriteConfig } from '../services/modelRewrite.js';
import { runWatcherOnce } from '../services/watcher.js';
import { nineRouterLogMetrics } from '../services/nineRouterLogMetrics.js';

const PolicyPatch = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(),
  imageDailyLimit: z.number().int().positive().nullable().optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  resetPolicy: z.enum(['manual', 'daily', 'monthly', 'custom']).optional(),
  actionOnLimit: z.enum(['alert', 'disable', 'none']).optional(),
  notes: z.string().nullable().optional(),
  usageMultiplier: z.number().min(0).max(100).optional(),
});
const ModelRewriteRuleBody = z.object({ id: z.number().int().positive().optional(), groupId: z.number().int().positive().nullable().optional(), enabled: z.boolean().optional(), fromModel: z.string(), toModel: z.string().nullable().optional(), toModels: z.array(z.string()).optional(), stickyCount: z.number().int().positive().optional(), targetWeights: z.array(z.number().int().positive()).optional() });
const ModelRewriteGroupBody = z.object({ id: z.number().int().positive().optional(), name: z.string().optional(), enabled: z.boolean().optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const ModelRewriteConfigBody = z.object({ enabled: z.boolean(), groups: z.array(ModelRewriteGroupBody).optional(), rules: z.array(ModelRewriteRuleBody).optional() });
const FinalFallbackConfigBody = z.object({ enabled: z.boolean(), model: z.string(), models: z.array(z.string()).optional() });
const ModelRateLimitRuleBody = z.object({ model: z.string(), enabled: z.boolean(), rpm: z.number().positive(), queueLimit: z.number().int().nonnegative(), maxQueueWaitMs: z.number().positive() });
const ModelRateLimitConfigBody = z.object({ enabled: z.boolean(), rules: z.array(ModelRateLimitRuleBody) });
const ClientRateLimitConfigBody = z.object({ enabled: z.boolean(), rpm: z.number().positive(), concurrency: z.number().int().positive() });

type AuthHook = (req: unknown, reply: unknown) => Promise<unknown> | unknown;

export type AdminRouteOptions = {
  db: Database.Database;
  requireAuth: AuthHook;
  usageResponse: () => unknown;
  finalFallbackStore: {
    get: () => FinalFallbackConfig;
    save: (config: FinalFallbackConfig) => FinalFallbackConfig;
  };
  modelRateLimitStore: {
    get: () => ModelRateLimitConfig;
    save: (config: ModelRateLimitConfig) => ModelRateLimitConfig;
  };
  modelRateLimiter: {
    updateConfig: (config: ModelRateLimitConfig) => void;
  };
  clientRateLimitStore: {
    get: () => ClientRateLimitConfig;
    save: (config: ClientRateLimitConfig) => ClientRateLimitConfig;
  };
  clientRateLimiter: {
    updateConfig: (config: ClientRateLimitConfig) => void;
  };
  ensurePolicies: () => unknown;
  maybeUnlockQuotaAfterPolicyChange: (keyId: string) => void;
  invalidateApiKeyCache: () => void;
  invalidateUsageSummaryCache: () => void;
  hardDisable: () => boolean;
};

function mutationOk(keyId: string) {
  return { ok: true, keyId };
}

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions) {
  const {
    db,
    requireAuth,
    usageResponse,
    finalFallbackStore,
    modelRateLimitStore,
    modelRateLimiter,
    clientRateLimitStore,
    clientRateLimiter,
    ensurePolicies,
    maybeUnlockQuotaAfterPolicyChange,
    invalidateApiKeyCache,
    invalidateUsageSummaryCache,
    hardDisable,
  } = options;

  app.register(async protectedRoutes => {
    protectedRoutes.addHook('preHandler', requireAuth as any);
    protectedRoutes.get('/api/config/status', async () => buildConfigStatus());
    protectedRoutes.get('/api/keys/usage', async () => usageResponse());
    protectedRoutes.get('/api/traffic/summary', async () => nineRouterLogMetrics.summary());
    protectedRoutes.get('/api/model-rewrite/config', async () => getModelRewriteConfig(db));
    protectedRoutes.put('/api/model-rewrite/config', async (req) => saveModelRewriteConfig(db, ModelRewriteConfigBody.parse(req.body)));
    protectedRoutes.get('/api/final-fallback/config', async () => finalFallbackStore.get());
    protectedRoutes.put('/api/final-fallback/config', async (req) => finalFallbackStore.save(FinalFallbackConfigBody.parse(req.body)));
    protectedRoutes.get('/api/model-rate-limit/config', async () => modelRateLimitStore.get());
    protectedRoutes.put('/api/model-rate-limit/config', async (req) => {
      const next = modelRateLimitStore.save(ModelRateLimitConfigBody.parse(req.body));
      modelRateLimiter.updateConfig(next);
      return next;
    });
    protectedRoutes.get('/api/client-rate-limit/config', async () => clientRateLimitStore.get());
    protectedRoutes.put('/api/client-rate-limit/config', async (req) => {
      const next = clientRateLimitStore.save(ClientRateLimitConfigBody.parse(req.body));
      clientRateLimiter.updateConfig(next);
      return next;
    });
    protectedRoutes.patch('/api/keys/:keyId/policy', async (req) => {
      const { keyId } = req.params as { keyId: string };
      ensurePolicies();
      const body = PolicyPatch.parse(req.body);
      const current = db.prepare('SELECT * FROM key_policies WHERE key_id = ?').get(keyId) as any;
      if (!current) {
        const err = new Error('key policy not found') as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      const currentMultiplier = Number(current.usage_multiplier ?? 1);
      const nextMultiplier = body.usageMultiplier === undefined ? currentMultiplier : body.usageMultiplier;
      const multiplierChanged = body.usageMultiplier !== undefined && nextMultiplier !== currentMultiplier;
      const effectiveAt = multiplierChanged ? new Date().toISOString() : current.usage_multiplier_effective_at;
      db.transaction(() => {
        db.prepare(`UPDATE key_policies SET token_limit = ?, image_daily_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(
          body.tokenLimit === undefined ? current.token_limit : body.tokenLimit,
          body.imageDailyLimit === undefined ? current.image_daily_limit : body.imageDailyLimit,
          body.windowStart ?? current.window_start,
          body.windowEnd === undefined ? current.window_end : body.windowEnd,
          body.expiresAt === undefined ? current.expires_at : body.expiresAt,
          body.resetPolicy ?? current.reset_policy,
          body.actionOnLimit ?? current.action_on_limit,
          body.notes === undefined ? current.notes : body.notes,
          nextMultiplier,
          effectiveAt,
          keyId,
        );
        if (multiplierChanged) db.prepare('INSERT INTO usage_multiplier_events (key_id, multiplier, effective_at) VALUES (?, ?, ?)').run(keyId, nextMultiplier, effectiveAt);
      })();
      db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'policy.update', JSON.stringify(body));
      maybeUnlockQuotaAfterPolicyChange(keyId);
      invalidateApiKeyCache();
      invalidateUsageSummaryCache();
      return mutationOk(keyId);
    });
    protectedRoutes.post('/api/keys/:keyId/reset-window', async (req, reply) => {
      const { keyId } = req.params as { keyId: string };
      const current = db.prepare('SELECT reset_policy FROM key_policies WHERE key_id = ?').get(keyId) as any;
      if (!current) return reply.code(404).send({ error: 'key policy not found' });
      if (current.reset_policy === 'daily' || current.reset_policy === 'monthly') return reply.code(409).send({ error: `reset-window is only available for manual/custom policies; ${current.reset_policy} windows reset automatically` });
      const windowStart = new Date().toISOString();
      db.prepare('UPDATE key_policies SET window_start = ?, window_end = NULL, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?').run(windowStart, keyId);
      db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(keyId, 'window.reset', windowStart);
      invalidateApiKeyCache();
      invalidateUsageSummaryCache();
      return mutationOk(keyId);
    });
    protectedRoutes.post('/api/watcher/run', async () => {
      const out = runWatcherOnce(db, { hardDisable: hardDisable() });
      invalidateApiKeyCache();
      return out;
    });
    protectedRoutes.get('/api/audit', async () => db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  });
}
