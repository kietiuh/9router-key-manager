# Per-key Model Access Restriction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each API key declare a whitelist of allowed *incoming* model names; requests whose raw model is not whitelisted are rejected with 403, while model rewrite and final fallback remain unrestricted.

**Architecture:** Add a nullable `allowed_models_json` column to `key_policies`. A new focused `keyModelAccessInterceptor` service reads the whitelist and decides block/pass based on the raw request model. Wire it into the `/v1/*` proxy after the existing key-access and quota interceptors and before model-rewrite planning. Expose the whitelist through the existing per-key policy PATCH endpoint and the admin key drawer.

**Tech Stack:** TypeScript, Fastify, React, better-sqlite3, Vitest.

## Global Constraints

- Work on branch `feature/per-key-model-access` cut from `main`. Do not commit to `main` directly.
- Migration must be `ALTER TABLE ... ADD COLUMN` with a nullable column (backward-compatible, no backfill).
- `NULL` column and empty array `[]` both mean **full access** (no restriction).
- The check operates on the **raw incoming model name only** — never on rewrite targets or final fallback models.
- Match is case-sensitive exact string match. No wildcards/globs.
- Blocked requests return HTTP 403 with `error.type: 'permission_denied'`, `error.code: 'model_not_allowed'`. Log at `info` level.
- Do not expose the whitelist through `POST /api/public/key-check`.
- ES module imports use the `.js` extension in source (`import ... from './x.js'`), matching the existing codebase.
- Vietnamese + English i18n strings required for any new UI copy.

---

### Task 1: Schema migration for `allowed_models_json`

**Files:**
- Modify: `src/server/db/schema.ts:143-148` (the `key_policies` `PRAGMA table_info` migration block)

**Interfaces:**
- Produces: a nullable `allowed_models_json TEXT` column on `key_policies`, present after `migrate(db)` runs.

- [ ] **Step 1: Add the column to the CREATE TABLE statement**

In the `CREATE TABLE IF NOT EXISTS key_policies (...)` block (around `src/server/db/schema.ts:6-22`), add the column after `allow_final_fallback`:

```sql
      allow_final_fallback INTEGER NOT NULL DEFAULT 1,
      allowed_models_json TEXT,
      usage_multiplier REAL NOT NULL DEFAULT 1.0,
```

- [ ] **Step 2: Add the ALTER TABLE migration for existing databases**

In the `key_policies` migration block (after the `allow_final_fallback` line at `src/server/db/schema.ts:146`), add:

```ts
  if (!names.has('allowed_models_json')) db.exec('ALTER TABLE key_policies ADD COLUMN allowed_models_json TEXT');
```

- [ ] **Step 3: Verify migration compiles and runs**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/schema.ts
git commit -m "feat(schema): add allowed_models_json column to key_policies"
```

---

### Task 2: `keyModelAccessInterceptor` service

**Files:**
- Create: `src/server/services/keyModelAccessInterceptor.ts`
- Create: `src/server/services/keyModelAccessInterceptor.test.ts`

**Interfaces:**
- Consumes: `extractBearerToken` from `./quotaInterceptor.js`.
- Produces:
  - `readAllowedModels(db: Database.Database, keyId: string): string[]`
  - `evaluateKeyModelAccessInterceptor(opts: { db: Database.Database; authHeader: string | string[] | undefined; rawModel: string | undefined; lookupKey: (token: string) => { id: string } | undefined }): KeyModelAccessInterceptResult`
  - `buildKeyModelNotAllowedErrorBody(result)` → `{ error: { message, type, code, model, allowed_models } }`
  - type `KeyModelAccessInterceptResult = { blocked: true; status: 403; code: 'model_not_allowed'; keyId: string; model: string; allowedModels: string[] } | { blocked: false }`

- [ ] **Step 1: Write the failing tests**

Create `src/server/services/keyModelAccessInterceptor.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildKeyModelNotAllowedErrorBody,
  evaluateKeyModelAccessInterceptor,
  readAllowedModels,
} from './keyModelAccessInterceptor.js';

function newDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE key_policies (
      key_id TEXT PRIMARY KEY,
      allowed_models_json TEXT
    );
  `);
  return db;
}

describe('readAllowedModels', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('returns [] when the column is NULL', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', null);
    expect(readAllowedModels(db, 'k1')).toEqual([]);
  });

  it('returns [] when the key has no policy row', () => {
    expect(readAllowedModels(db, 'missing')).toEqual([]);
  });

  it('returns a trimmed, deduped list for valid JSON', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['  claude-opus-4.8 ', 'gpt-5.5', 'claude-opus-4.8', '']));
    expect(readAllowedModels(db, 'k1')).toEqual(['claude-opus-4.8', 'gpt-5.5']);
  });

  it('returns [] on invalid JSON', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', 'not-json');
    expect(readAllowedModels(db, 'k1')).toEqual([]);
  });
});

describe('evaluateKeyModelAccessInterceptor', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('does not block when Authorization is missing', () => {
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: undefined, rawModel: 'x', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when the token is unknown', () => {
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk-missing', rawModel: 'x', lookupKey: () => undefined }).blocked).toBe(false);
  });

  it('does not block when rawModel is undefined', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8']));
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: undefined, lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when the whitelist is empty', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', null);
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: 'anything', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('does not block when rawModel is in the whitelist', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8']));
    expect(evaluateKeyModelAccessInterceptor({ db, authHeader: 'Bearer sk', rawModel: 'claude-opus-4.8', lookupKey: () => ({ id: 'k1' }) }).blocked).toBe(false);
  });

  it('blocks when rawModel is not in the whitelist', () => {
    db.prepare('INSERT INTO key_policies (key_id, allowed_models_json) VALUES (?, ?)').run('k1', JSON.stringify(['claude-opus-4.8', 'gpt-5.5']));
    const result = evaluateKeyModelAccessInterceptor({
      db,
      authHeader: 'Bearer sk',
      rawModel: 'claude-haiku-5',
      lookupKey: () => ({ id: 'k1' }),
    });
    expect(result).toEqual({
      blocked: true,
      status: 403,
      code: 'model_not_allowed',
      keyId: 'k1',
      model: 'claude-haiku-5',
      allowedModels: ['claude-opus-4.8', 'gpt-5.5'],
    });
  });
});

describe('buildKeyModelNotAllowedErrorBody', () => {
  it('serializes an OpenAI-compatible model_not_allowed error', () => {
    const body = buildKeyModelNotAllowedErrorBody({
      blocked: true,
      status: 403,
      code: 'model_not_allowed',
      keyId: 'k1',
      model: 'claude-haiku-5',
      allowedModels: ['claude-opus-4.8'],
    });
    expect(body.error).toEqual({
      message: "Model 'claude-haiku-5' is not allowed for this API key.",
      type: 'permission_denied',
      code: 'model_not_allowed',
      model: 'claude-haiku-5',
      allowed_models: ['claude-opus-4.8'],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/server/services/keyModelAccessInterceptor.test.ts`
Expected: FAIL — module `./keyModelAccessInterceptor.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `src/server/services/keyModelAccessInterceptor.ts`:

```ts
import type Database from 'better-sqlite3';
import { extractBearerToken } from './quotaInterceptor.js';

export type KeyModelAccessLookupResult = {
  id: string;
};

export type KeyModelAccessLookup = (token: string) => KeyModelAccessLookupResult | undefined;

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

export function readAllowedModels(db: Database.Database, keyId: string): string[] {
  const row = db.prepare('SELECT allowed_models_json FROM key_policies WHERE key_id = ?').get(keyId) as { allowed_models_json?: string | null } | undefined;
  const raw = row?.allowed_models_json;
  if (!raw) return [];
  try {
    return normalizeList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function evaluateKeyModelAccessInterceptor(opts: {
  db: Database.Database;
  authHeader: string | string[] | undefined;
  rawModel: string | undefined;
  lookupKey: KeyModelAccessLookup;
}): KeyModelAccessInterceptResult {
  const token = extractBearerToken(opts.authHeader);
  if (!token) return { blocked: false };
  const key = opts.lookupKey(token);
  if (!key) return { blocked: false };
  const model = typeof opts.rawModel === 'string' ? opts.rawModel.trim() : '';
  if (!model) return { blocked: false };
  const allowedModels = readAllowedModels(opts.db, key.id);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/server/services/keyModelAccessInterceptor.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/server/services/keyModelAccessInterceptor.ts src/server/services/keyModelAccessInterceptor.test.ts
git commit -m "feat(proxy): add key model access interceptor service"
```

---

### Task 3: Wire the interceptor into the proxy hot path

**Files:**
- Modify: `src/server/routes/proxy.ts:10` (imports), `src/server/routes/proxy.ts:130-137` (rewrite parsing block)
- Modify: `src/server/app.test.ts` (integration tests, append to the existing `describe` block)

**Interfaces:**
- Consumes: `evaluateKeyModelAccessInterceptor`, `buildKeyModelNotAllowedErrorBody` from `../services/keyModelAccessInterceptor.js`; the existing `lookupKey`, `db`, and `parsed` local in the `/v1/*` handler.

- [ ] **Step 1: Write the failing integration tests**

Append these three tests inside the `describe('server app routes', ...)` block in `src/server/app.test.ts` (before the closing `});` at line 288):

```ts
  it('blocks a request whose model is not in the key whitelist', async () => {
    const calls: string[] = [];
    const key = { id: 'key-restricted', name: 'Restricted', key: 'sk-restricted', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-haiku-5', messages: [] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
    expect(res.json().error.allowed_models).toEqual(['claude-opus-4.8']);
    expect(calls).toEqual([]);
  });

  it('allows a request whose model is in the key whitelist', async () => {
    const calls: string[] = [];
    const key = { id: 'key-allowed', name: 'Allowed', key: 'sk-allowed', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}/policy`,
      headers: { cookie },
      payload: { allowedModels: ['claude-opus-4.8'] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-opus-4.8', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['claude-opus-4.8']);
  });

  it('does not restrict models when the whitelist is cleared with null', async () => {
    const calls: string[] = [];
    const key = { id: 'key-cleared', name: 'Cleared', key: 'sk-cleared', isActive: true };
    const { instance: server } = await app({
      readApiKeys: () => [key],
      fetchImpl: async (_input, init) => {
        calls.push(JSON.parse(Buffer.from(init?.body as Buffer).toString('utf8')).model);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const cookie = await adminCookie(server);
    await server.inject({ method: 'PATCH', url: `/api/keys/${key.id}/policy`, headers: { cookie }, payload: { allowedModels: ['claude-opus-4.8'] } });
    await server.inject({ method: 'PATCH', url: `/api/keys/${key.id}/policy`, headers: { cookie }, payload: { allowedModels: null } });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      payload: { model: 'claude-haiku-5', messages: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['claude-haiku-5']);
  });
```

Note: these tests depend on the admin PATCH accepting `allowedModels` (Task 4). They will fail until both Task 3 and Task 4 are done. Run them at the end of Task 4.

- [ ] **Step 2: Add the import to proxy.ts**

At `src/server/routes/proxy.ts:10`, after the `keyAccessInterceptor` import, add:

```ts
import { buildKeyModelNotAllowedErrorBody, evaluateKeyModelAccessInterceptor } from '../services/keyModelAccessInterceptor.js';
```

- [ ] **Step 3: Wire the interceptor after body parsing, before rewrite planning**

In `src/server/routes/proxy.ts`, the current block at lines 130-137 reads:

```ts
      let decision;
      let rewritePlan: RewriteTargetPlan | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const parsed = parseModelRewriteRequest(rawBody ?? Buffer.from(''), req.headers['content-type']);
        rewritePlan = parsed.model ? selectModelRewriteTargets(db, parsed.model) : undefined;
        decision = applyRewritePlan(parsed, rewritePlan);
        if (decision.rewritten) req.log.info({ fromModel: decision.fromModel, toModel: decision.toModel, targets: decision.targets }, 'model rewritten');
      }
```

Replace it with:

```ts
      let decision;
      let rewritePlan: RewriteTargetPlan | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const parsed = parseModelRewriteRequest(rawBody ?? Buffer.from(''), req.headers['content-type']);
        const modelAccess = evaluateKeyModelAccessInterceptor({
          db,
          authHeader: req.headers.authorization,
          rawModel: parsed.model,
          lookupKey,
        });
        if (modelAccess.blocked) {
          req.log.info({ keyId: modelAccess.keyId, model: modelAccess.model }, 'model access blocked');
          releaseClientLease();
          return reply.code(modelAccess.status).send(buildKeyModelNotAllowedErrorBody(modelAccess));
        }
        rewritePlan = parsed.model ? selectModelRewriteTargets(db, parsed.model) : undefined;
        decision = applyRewritePlan(parsed, rewritePlan);
        if (decision.rewritten) req.log.info({ fromModel: decision.fromModel, toModel: decision.toModel, targets: decision.targets }, 'model rewritten');
      }
```

Note: `releaseClientLease()` is already defined earlier in the handler (line ~111) and the client rate-limit lease may already be acquired at this point, so we must release it before the early return to avoid leaking a concurrency slot.

- [ ] **Step 4: Verify the proxy still compiles**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/proxy.ts src/server/app.test.ts
git commit -m "feat(proxy): enforce per-key model whitelist on incoming model"
```

---

### Task 4: Admin PATCH endpoint support

**Files:**
- Modify: `src/server/routes/admin.ts:10-21` (`PolicyPatch` schema), `src/server/routes/admin.ts:103-139` (the PATCH handler SQL + audit)

**Interfaces:**
- Consumes: the `allowed_models_json` column from Task 1.
- Produces: PATCH `/api/keys/:keyId/policy` accepts `allowedModels?: string[] | null`; writes `NULL` for `null`/`[]`, or `JSON.stringify(trimmedDedupedArray)` otherwise.

- [ ] **Step 1: Add `allowedModels` to the PolicyPatch zod schema**

In `src/server/routes/admin.ts`, the `PolicyPatch` object (lines 10-21) currently ends with:

```ts
  usageMultiplier: z.number().min(0).max(100).optional(),
});
```

Change it to:

```ts
  usageMultiplier: z.number().min(0).max(100).optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
});
```

- [ ] **Step 2: Add a normalization helper above `registerAdminRoutes`**

In `src/server/routes/admin.ts`, just above `function mutationOk(keyId: string)` (line 61), add:

```ts
function normalizeAllowedModels(input: string[] | null | undefined): string[] | null {
  if (input == null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const value = String(item ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length ? out : null;
}
```

- [ ] **Step 3: Persist the column in the UPDATE statement**

In the PATCH handler (`src/server/routes/admin.ts:117-133`), the `db.transaction(() => { ... })()` block runs an `UPDATE key_policies SET ...`. Update it to include the new column.

First, before the transaction (after the `effectiveAt` line at 116), compute the value:

```ts
      const nextAllowedModels = body.allowedModels === undefined
        ? (current.allowed_models_json ?? null)
        : (() => { const n = normalizeAllowedModels(body.allowedModels); return n ? JSON.stringify(n) : null; })();
```

Then change the `UPDATE` statement from:

```ts
        db.prepare(`UPDATE key_policies SET token_limit = ?, image_daily_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, allow_final_fallback = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(
          body.tokenLimit === undefined ? current.token_limit : body.tokenLimit,
          body.imageDailyLimit === undefined ? current.image_daily_limit : body.imageDailyLimit,
          body.windowStart ?? current.window_start,
          body.windowEnd === undefined ? current.window_end : body.windowEnd,
          body.expiresAt === undefined ? current.expires_at : body.expiresAt,
          body.resetPolicy ?? current.reset_policy,
          body.actionOnLimit ?? current.action_on_limit,
          body.notes === undefined ? current.notes : body.notes,
          body.allowFinalFallback === undefined ? current.allow_final_fallback : Number(body.allowFinalFallback),
          nextMultiplier,
          effectiveAt,
          keyId,
        );
```

to:

```ts
        db.prepare(`UPDATE key_policies SET token_limit = ?, image_daily_limit = ?, window_start = ?, window_end = ?, expires_at = ?, reset_policy = ?, action_on_limit = ?, notes = ?, allow_final_fallback = ?, usage_multiplier = ?, usage_multiplier_effective_at = ?, allowed_models_json = ?, updated_at = CURRENT_TIMESTAMP WHERE key_id = ?`).run(
          body.tokenLimit === undefined ? current.token_limit : body.tokenLimit,
          body.imageDailyLimit === undefined ? current.image_daily_limit : body.imageDailyLimit,
          body.windowStart ?? current.window_start,
          body.windowEnd === undefined ? current.window_end : body.windowEnd,
          body.expiresAt === undefined ? current.expires_at : body.expiresAt,
          body.resetPolicy ?? current.reset_policy,
          body.actionOnLimit ?? current.action_on_limit,
          body.notes === undefined ? current.notes : body.notes,
          body.allowFinalFallback === undefined ? current.allow_final_fallback : Number(body.allowFinalFallback),
          nextMultiplier,
          effectiveAt,
          nextAllowedModels,
          keyId,
        );
```

The audit log line at 134 already serializes the whole `body` via `JSON.stringify(body)`, so `allowedModels` is automatically captured — no change needed there.

- [ ] **Step 4: Run the full server test suite (includes Task 3 integration tests)**

Run: `npm test -- src/server/app.test.ts src/server/services/keyModelAccessInterceptor.test.ts`
Expected: PASS — including the three integration tests added in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/admin.ts
git commit -m "feat(admin): accept allowedModels in per-key policy patch"
```

---

### Task 5: Surface `allowedModels` on `KeyUsageSummary`

**Files:**
- Modify: `src/shared/types.ts:15-19` (`Policy`-related — actually the `KeyUsageSummary` type at 35-69) and `src/server/services/policyUsage.ts` `Policy` type is in `usage.ts`
- Modify: `src/server/services/usage.ts:4-19` (`Policy` type) and `src/server/services/usage.ts:127-152` (summary object)
- Modify: `src/shared/types.ts` (`KeyUsageSummary`)
- Modify: `src/server/app.ts:151` (strip `allowedModels` from the public `/api/public/key-check` response — keep the whitelist admin-only)
- Modify: `src/server/services/usage.test.ts`

**Interfaces:**
- Consumes: `allowed_models_json` column (auto-loaded by `resolvedPolicies` via `SELECT *`).
- Produces: `KeyUsageSummary.allowedModels: string[]` (empty array = full access) available to the client.

- [ ] **Step 1: Add `allowed_models_json` to the `Policy` type**

In `src/server/services/usage.ts`, the `Policy` type (lines 4-19) currently ends with:

```ts
  usage_multiplier_events?: Array<{ multiplier: number; effective_at: string }> | null;
};
```

Add the field before the closing brace:

```ts
  usage_multiplier_events?: Array<{ multiplier: number; effective_at: string }> | null;
  allowed_models_json?: string | null;
};
```

- [ ] **Step 1.5: Strip `allowedModels` from the public key-check response**

In `src/server/app.ts:151`, the destructure that hides admin-only fields is currently:

```ts
  const { modelUsage: _modelUsage, models: _models, ...publicSummary } = summary;
```

Change it to also drop the whitelist (the whitelist is admin-only and must never appear in `POST /api/public/key-check`):

```ts
  const { modelUsage: _modelUsage, models: _models, allowedModels: _allowedModels, ...publicSummary } = summary;
```

No dedicated unit test — the existing public-check tests assert on top-level shape but not on this specific field. A code review of `app.ts` is sufficient.

- [ ] **Step 2: Add `allowedModels` to `KeyUsageSummary`**

In `src/shared/types.ts`, in the `KeyUsageSummary` type, after `allowFinalFallback: boolean;` (line 50) add:

```ts
  allowFinalFallback: boolean;
  allowedModels: string[];
```

- [ ] **Step 3: Write the failing test**

In `src/server/services/usage.test.ts`, add a test that verifies the summary parses the column. Add inside the existing top-level `describe` block:

```ts
  it('exposes allowedModels parsed from the policy column', () => {
    const keys = [{ id: 'k1', name: 'K1', key: 'sk-1', isActive: true }];
    const policies = [{ key_id: 'k1', window_start: '1970-01-01T00:00:00.000Z', allowed_models_json: JSON.stringify(['claude-opus-4.8', '', 'claude-opus-4.8']) }];
    const summary = summarizeKeyUsage(keys, [], policies).at(0)!;
    expect(summary.allowedModels).toEqual(['claude-opus-4.8']);
  });

  it('returns an empty allowedModels list when the column is null', () => {
    const keys = [{ id: 'k1', name: 'K1', key: 'sk-1', isActive: true }];
    const policies = [{ key_id: 'k1', window_start: '1970-01-01T00:00:00.000Z', allowed_models_json: null }];
    const summary = summarizeKeyUsage(keys, [], policies).at(0)!;
    expect(summary.allowedModels).toEqual([]);
  });
```

If `summarizeKeyUsage` is not already imported at the top of `usage.test.ts`, add it to the existing import from `./usage.js`.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- src/server/services/usage.test.ts`
Expected: FAIL — `summary.allowedModels` is `undefined`.

- [ ] **Step 5: Add a parse helper and populate the summary**

In `src/server/services/usage.ts`, add a helper near `tokenTotal` (after line 50):

```ts
function parseAllowedModels(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    const value = String(item ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
```

Then in the returned summary object (around line 142, after `allowFinalFallback: ...`), add:

```ts
      allowFinalFallback: p?.allow_final_fallback == null ? true : Number(p.allow_final_fallback) !== 0,
      allowedModels: parseAllowedModels(p?.allowed_models_json),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/server/services/usage.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server/services/usage.ts src/server/services/usage.test.ts src/server/app.ts
git commit -m "feat(usage): expose allowedModels on key usage summary"
```

---

### Task 6: Admin UI — key drawer textarea and i18n

**Files:**
- Modify: `src/client/i18n.ts:8` (en dict), `src/client/i18n.ts:11` (vi dict)
- Modify: `src/client/KeyDrawer.tsx:19-27` (the policy `<form>`)
- Modify: `src/client/Dashboard.tsx:80-89` (`savePolicy`)
- Modify: `src/client/style.css` (reuse `.hintText`)

**Interfaces:**
- Consumes: `KeyUsageSummary.allowedModels` (Task 5); the PATCH endpoint's `allowedModels` field (Task 4).
- Produces: a textarea in the key drawer that reads/writes the whitelist.

- [ ] **Step 1: Add i18n strings to both dictionaries**

In `src/client/i18n.ts`, in the `en` object, append these keys before the closing brace of `en` (after `loading: 'Loading…'` at line 8):

```ts
, allowedModels: 'Allowed models', allowedModelsPlaceholder: 'One model per line', allowedModelsHint: 'Empty = allow all models. Only the original incoming model is checked; rewrite targets and final fallback are not restricted.', restrictedBadge: 'Restricted'
```

In the `vi` object, append before its closing brace (after `loading: 'Đang tải…'` at line 11):

```ts
, allowedModels: 'Model được phép', allowedModelsPlaceholder: 'Mỗi model một dòng', allowedModelsHint: 'Để trống = cho phép tất cả model. Chỉ kiểm tra model gốc gửi lên; rewrite target và final fallback không bị giới hạn.', restrictedBadge: 'Giới hạn'
```

- [ ] **Step 2: Add the textarea to the key drawer form**

In `src/client/KeyDrawer.tsx`, after the `finalFallback` label (line 24):

```tsx
      <label>{t.finalFallback}<input name="allowFinalFallback" type="checkbox" defaultChecked={selected.allowFinalFallback !== false} /></label>
```

add:

```tsx
      <label>{t.allowedModels}<textarea name="allowedModels" rows={3} placeholder={t.allowedModelsPlaceholder} defaultValue={(selected.allowedModels ?? []).join('\n')} /></label>
      <p className="hintText">{t.allowedModelsHint}</p>
```

- [ ] **Step 3: Parse and send the whitelist in savePolicy**

In `src/client/Dashboard.tsx`, the `savePolicy` function body (lines 82-88) currently builds the PATCH body inline. Replace the `await api(...)` call with:

```ts
      const allowedRaw = String(fd.get('allowedModels') ?? '');
      const allowedModels = allowedRaw.split('\n').map(s => s.trim()).filter(Boolean);
      await api(`/api/keys/${k.keyId}/policy`, { method: 'PATCH', body: JSON.stringify({ tokenLimit: fd.get('tokenLimit') ? Number(fd.get('tokenLimit')) : null, actionOnLimit: fd.get('actionOnLimit'), resetPolicy: fd.get('resetPolicy'), expiresAt: fromVnInput(fd.get('expiresAt')), usageMultiplier: fd.get('usageMultiplier') ? Number(fd.get('usageMultiplier')) : 1, allowFinalFallback: fd.get('allowFinalFallback') === 'on', allowedModels: allowedModels.length ? allowedModels : null }) });
```

- [ ] **Step 4: Verify the client type-checks and builds**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no type errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/client/i18n.ts src/client/KeyDrawer.tsx src/client/Dashboard.tsx
git commit -m "feat(admin-ui): add allowed models editor to key drawer"
```

---

### Task 7: Restricted badge in key list and detail (optional polish)

**Files:**
- Modify: `src/client/KeyDrawer.tsx:12-13` (status pill line)

**Interfaces:**
- Consumes: `KeyUsageSummary.allowedModels`, `t.restrictedBadge`.

- [ ] **Step 1: Show a restricted pill next to the status in the drawer header**

In `src/client/KeyDrawer.tsx`, the line (13):

```tsx
    <p><code>{selected.keyMasked}</code> <span className={`pill ${selected.status}`}>{statusLabel(selected.status, lang)}</span> <button type="button" className="linkButton" onClick={() => onViewDetail(selected)}>{t.viewDetail}</button></p>
```

Add a restricted pill after the status span:

```tsx
    <p><code>{selected.keyMasked}</code> <span className={`pill ${selected.status}`}>{statusLabel(selected.status, lang)}</span>{selected.allowedModels && selected.allowedModels.length > 0 && <span className="pill warning"> {t.restrictedBadge} · {selected.allowedModels.length}</span>} <button type="button" className="linkButton" onClick={() => onViewDetail(selected)}>{t.viewDetail}</button></p>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/client/KeyDrawer.tsx
git commit -m "feat(admin-ui): show restricted badge for whitelisted keys"
```

---

### Task 8: Docs and full verification

**Files:**
- Modify: `README.md` (Config section)

**Interfaces:** none (documentation + final gate).

- [ ] **Step 1: Document the feature in README**

In `README.md`, under the `## Config` section (near the per-key policy notes), add a bullet:

```markdown
- Per-key model whitelist: each key can restrict which **incoming** model names it accepts, configured from the admin key drawer ("Allowed models", one model per line). Empty = full access. Model rewrite targets and final fallback models are **not** restricted — only the raw model in the request body is checked. Stored in `manager.sqlite` (`key_policies.allowed_models_json`).
```

- [ ] **Step 2: Run the full verification suite**

Run each and confirm all pass:

```bash
npm test
./node_modules/.bin/tsc --noEmit
npm run build
npm run lint
```

Expected: all green. If `npm run lint` flags the new files, fix lint issues and re-run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document per-key model whitelist"
```

- [ ] **Step 4: Push the branch and open a PR**

```bash
git push -u origin feature/per-key-model-access
gh pr create --base main --title "feat: per-key model access whitelist" --body "$(cat <<'EOF'
## Summary
- Add per-key `allowed_models_json` whitelist restricting the raw incoming model name
- New `keyModelAccessInterceptor` service; wired into `/v1/*` after key-access/quota, before model rewrite
- Admin key drawer gains an "Allowed models" editor; whitelist surfaced on key usage summary
- Rewrite targets and final fallback are intentionally NOT restricted

## Testing
- `npm test` (unit + integration), `tsc --noEmit`, `npm run build`, `npm run lint`

## Deploy
- Migration is `ALTER TABLE ADD COLUMN` (nullable, backward-compatible; existing keys default to full access)
- After merge: `git pull && npm ci` on the VPS, then restart the service (~2-5s downtime)
- Verify `/api/health` and `/api/keys/usage`; monitor logs for unexpected `model access blocked` from existing keys (should be zero)
EOF
)"
```

---

## Deploy runbook (post-merge, on the VPS)

Run after the PR is approved and merged to `main`:

1. `cd` into the deployment directory (adjust path if different from `/opt/9router-key-manager`).
2. `git pull` on `main`.
3. `npm ci` — no separate migration script; schema runs on first DB open at process start.
4. Restart the systemd unit (expected downtime ~2-5s while Node reloads). Confirm the exact unit name on the box before running.
5. Verify `GET /api/health` returns ok and `GET /api/keys/usage` loads.
6. Watch logs for ~5 minutes for unexpected `model access blocked` entries from existing keys — there should be none, since all existing keys have `NULL` (full access).

## Self-Review Notes

- **Spec coverage:** schema (Task 1), interceptor service + tests (Task 2), proxy wiring + integration tests (Task 3), admin PATCH (Task 4), summary exposure (Task 5), UI textarea + i18n (Task 6), restricted badge (Task 7), docs + deploy (Task 8). All spec sections mapped.
- **Client lease leak:** Task 3 explicitly calls `releaseClientLease()` before the early 403 return — the spec's proxy snippet omitted this; the plan corrects it because the client rate-limit lease is acquired earlier in the handler.
- **Public endpoint:** Task 5 Step 1.5 strips `allowedModels` from the `/api/public/key-check` response in `app.ts:151`, so the whitelist stays admin-only. Without this step the whitelist would leak via the public summary.
