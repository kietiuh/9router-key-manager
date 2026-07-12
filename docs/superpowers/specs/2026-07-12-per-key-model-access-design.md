# Per-key Model Access Restriction — Design

**Date:** 2026-07-12
**Status:** Approved for planning
**Branch:** `feature/per-key-model-access` (to be created)
**Deploy target:** production key-manager on gocinema VPS

## Goal

Each API key can declare an explicit whitelist of model names that callers are allowed to invoke through the proxy. By default (no whitelist) the key has full access; when a whitelist is set, only requests whose **incoming model name** matches a whitelisted entry are allowed. Model rewrite targets and final fallback targets are **not** restricted — they are free to map to any model.

## Motivation

Operators want to lock a key to a small set of vetted models (e.g. only `claude-opus-4.8`) without losing the operational benefits of model rewrite (e.g. rewriting `claude-opus-4.8` to `super/claude-opus-4.8`) and final fallback chains. The check must therefore operate on the **raw model name from the incoming request body**, not on the rewritten model or any fallback model the proxy actually ends up calling upstream.

## Out of scope

- Wildcard / glob patterns in whitelist entries (deferred).
- Per-model rate limits or quotas (already handled by `modelRateLimiter`).
- Per-key rewrite rules (rewrites remain a global admin config).
- Allowing the proxy to silently rewrite around the restriction. The check is a hard 403.

## Data model

Add one column to `key_policies`:

| Column | Type | Default | Semantics |
| --- | --- | --- | --- |
| `allowed_models_json` | `TEXT NULL` | `NULL` | `NULL` or `JSON '[]'` = full access (no restriction). Non-empty array = whitelist of allowed incoming model names. |

The new column follows the same migration style as `allow_final_fallback` and `usage_multiplier` — added through `db/schema.ts` using `PRAGMA table_info` checks and `ALTER TABLE ... ADD COLUMN` when missing. Existing rows default to `NULL` (full access), so the migration is backward-compatible with no data backfill required.

JSON shape stored in the column: a JSON array of strings, e.g. `["claude-opus-4.8","gpt-5.5"]`. Whitespace and empty strings are stripped at write time; duplicates are removed.

## Service: `keyModelAccessInterceptor`

New file: `src/server/services/keyModelAccessInterceptor.ts`. It mirrors the structure of `keyAccessInterceptor.ts` for consistency.

Public API:

```ts
export type KeyModelAccessInterceptResult =
  | { blocked: true; status: 403; code: 'model_not_allowed'; keyId: string; model: string; allowedModels: string[] }
  | { blocked: false };

export function readAllowedModels(db: Database.Database, keyId: string): string[];

export function evaluateKeyModelAccessInterceptor(opts: {
  db: Database.Database;
  authHeader: string | string[] | undefined;
  rawModel: string | undefined;
  lookupKey: (token: string) => { id: string } | undefined;
}): KeyModelAccessInterceptResult;

export function buildKeyModelNotAllowedErrorBody(result: Extract<KeyModelAccessInterceptResult, { blocked: true }>);
```

Resolution rules:

1. No `Authorization` header → not blocked (keyless access is already allowed; the proxy still enforces keyless paths).
2. Token does not resolve to a known key → not blocked (mirrors `keyAccessInterceptor` — unknown tokens fall through to upstream).
3. `rawModel` is `undefined` or empty (e.g. GET `/v1/models`) → not blocked. The interceptor never invents a model name.
4. `allowedModels` for that key is empty (NULL or `[]`) → not blocked. Full access.
5. `rawModel` matches any entry in `allowedModels` (case-sensitive exact match) → not blocked.
6. Otherwise → blocked with `code: 'model_not_allowed'`.

Lookup uses the same `extractBearerToken` helper from `quotaInterceptor.ts`.

## Proxy wiring

In `src/server/routes/proxy.ts`, the `/v1/*` handler currently parses the body once:

```ts
const parsed = parseModelRewriteRequest(rawBody ?? Buffer.from(''), req.headers['content-type']);
```

Insert the access check **immediately after this line and before `selectModelRewriteTargets`**:

```ts
const modelAccess = evaluateKeyModelAccessInterceptor({
  db,
  authHeader: req.headers.authorization,
  rawModel: parsed.model,
  lookupKey,
});
if (modelAccess.blocked) {
  req.log.info({ keyId: modelAccess.keyId, model: modelAccess.model }, 'model access blocked');
  return reply.code(modelAccess.status).send(buildKeyModelNotAllowedErrorBody(modelAccess));
}
```

Position is deliberate: the interceptor runs **after** key access expiry and quota interceptors (those remain first), and **before** model rewrite planning. That guarantees the rejection is logged with the original incoming model name, not a rewritten target.

GET/HEAD requests naturally pass because `parsed.model` is `undefined` — confirmed safe for `/v1/models` listings.

## Error response

```json
{
  "error": {
    "message": "Model 'claude-haiku-5' is not allowed for this API key.",
    "type": "permission_denied",
    "code": "model_not_allowed",
    "model": "claude-haiku-5",
    "allowed_models": ["claude-opus-4.8", "gpt-5.5"]
  }
}
```

- HTTP 403 (consistent with `key_expired`).
- Includes the whitelist so the caller can self-correct without admin intervention.
- Logged as `info` (not `warn`/`error`) — this is a client-side misuse signal, not a server failure.

## Admin API

Extend the existing PATCH endpoint `PUT /api/keys/:keyId/policy` (defined in `routes/admin.ts`). Add to `PolicyPatch`:

```ts
allowedModels: z.array(z.string()).nullable().optional()
```

Semantics:

- Field omitted → column unchanged.
- `null` or `[]` → column set to `NULL` (full access).
- Non-empty array → trim each entry, drop empties, dedupe (preserving first occurrence), then store as `JSON.stringify(arr)`.

Update the existing `UPDATE key_policies SET ...` statement to include `allowed_models_json = ?`. Append the same value to the audit log message JSON.

`GET /api/keys/usage` already returns key summaries — extend `KeyUsageSummary` (in `src/shared/types.ts`) with `allowedModels?: string[] | null` so the UI can render a "Restricted" badge without an extra round-trip.

The public `/api/public/key-check` endpoint strips `models` and `modelUsage`; do **not** add `allowedModels` to that response — whitelist stays admin-only.

## UI

### `KeyDrawer.tsx`

Add a new `<label>` after `finalFallback`:

```
<label>{t.allowedModels}
  <textarea
    name="allowedModels"
    rows={3}
    placeholder={t.allowedModelsPlaceholder}
    defaultValue={(selected.allowedModels ?? []).join('\n')}
  />
</label>
<p className="hint">{t.allowedModelsHint}</p>
```

### `Dashboard.tsx`

In `savePolicy`, parse the textarea:

```ts
const allowedRaw = String(fd.get('allowedModels') ?? '');
const allowedModels = allowedRaw.split('\n').map(s => s.trim()).filter(Boolean);
const allowedModelsPayload = allowedModels.length ? allowedModels : null;
```

Send `allowedModels: allowedModelsPayload` in the PATCH body.

### `AdminKeysSection.tsx` / `KeyDetailPage.tsx`

Optional badge: when `selected.allowedModels` is a non-empty array, render a small pill next to the status pill saying `Restricted · N`. No new tab needed; existing detail page handles it.

### i18n (`src/client/i18n.ts`)

Add to both `en` and `vi`:

- `allowedModels`: "Allowed models" / "Model được phép"
- `allowedModelsPlaceholder`: "One model per line" / "Mỗi model một dòng"
- `allowedModelsHint`: "Empty = allow all models. Only blocks the original incoming model — rewrite targets and final fallback are not restricted." / Vietnamese equivalent.
- `restrictedBadge`: "Restricted · {n}" / "Giới hạn · {n}"

## Files touched

### New

- `src/server/services/keyModelAccessInterceptor.ts`
- `src/server/services/keyModelAccessInterceptor.test.ts`

### Modified

- `src/server/db/schema.ts` — add column + migration.
- `src/server/routes/admin.ts` — extend `PolicyPatch`, update SQL, audit message.
- `src/server/routes/proxy.ts` — wire interceptor.
- `src/server/services/usage.ts` — populate `allowedModels` on `KeyUsageSummary` (the function already constructs the summary, so just read the new column).
- `src/shared/types.ts` — add `allowedModels?: string[] | null` to `KeyUsageSummary`.
- `src/client/KeyDrawer.tsx` — add textarea + hint.
- `src/client/Dashboard.tsx` — parse textarea and send PATCH payload.
- `src/client/i18n.ts` — add the four new strings.
- `src/client/AdminKeys.tsx` (if it renders the key list) — optional restricted badge.
- `src/client/KeyDetailPage.tsx` (or its helper) — optional restricted badge.

## Testing

### Unit (`keyModelAccessInterceptor.test.ts`)

Mirror the structure of `keyAccessInterceptor.test.ts`:

1. `readAllowedModels` — returns `[]` for NULL column; returns trimmed/deduped list for valid JSON; returns `[]` on invalid JSON (defensive).
2. `evaluateKeyModelAccessInterceptor`:
   - Missing `Authorization` → not blocked.
   - Token unknown → not blocked.
   - `rawModel` undefined → not blocked.
   - Whitelist empty → not blocked.
   - `rawModel` in whitelist → not blocked.
   - `rawModel` not in whitelist → blocked with `code: 'model_not_allowed'`, `keyId`, `model`, `allowedModels`.
3. `buildKeyModelNotAllowedErrorBody` — shape matches the documented JSON.

### Integration (`app.test.ts` or new file)

- PATCH a key with `allowedModels: ["claude-opus-4.8"]`; send a `/v1/chat/completions` request with `model: "claude-haiku-5"`; expect 403, `error.code === 'model_not_allowed'`, `error.allowed_models` contains the whitelist.
- Same PATCH; request with `model: "claude-opus-4.8"`; expect non-403 (proxy pass-through; upstream may fail but the interceptor must not block).
- PATCH with `allowedModels: null`; request with `claude-haiku-5`; expect no block.
- Audit log: PATCH with `allowedModels`; verify `audit_log` row references the array.

### Manual smoke

- Apply the change on the gocinema VPS test branch first; verify the admin UI renders the textarea; submit empty and non-empty values; observe the audit log.
- Confirm existing keys (no whitelist) behave exactly as before.

## Deploy

Production has live traffic. Plan:

1. Cut branch `feature/per-key-model-access` from `main`. Do all work there.
2. Run full `npm test` and `npm run build` on the branch; fix any breakages.
3. Open a PR into `main`. Reviewer checklist:
   - Migration is `ALTER TABLE ... ADD COLUMN` (non-breaking on existing rows).
   - No new required admin input — UI remains backward compatible (empty default = full access).
   - Audit log entry added for any policy change that touches `allowedModels`.
4. After approval and merge to `main`, on the VPS:
   ```bash
   cd /opt/9router-key-manager   # adjust if different
   git pull
   npm ci                         # no migration script needed; schema runs on first SELECT/INSERT
   # Service restart — expected downtime ~2-5 seconds while Node reloads.
   systemctl --user restart 9router-key-manager.service   # or whatever unit name applies
   ```
5. Restart, then verify `/api/health` returns ok and `/api/keys/usage` still loads.
6. Monitor logs for the first ~5 minutes for unexpected `model access blocked` entries from existing keys (should be zero).

Downtime window: the Node service restart is the only outage. Migration runs on next DB open, which is part of the same process start. No DB-level outage expected — `ALTER TABLE ADD COLUMN` on SQLite with the new column being nullable is a metadata-only operation on existing data.

## Risks & mitigations

- **Risk:** A misconfigured admin sets `allowedModels: []` (intending full access) and accidentally locks a key. **Mitigation:** UI shows explicit placeholder text and a hint; saved-but-empty sends `null` (full access); `readAllowedModels` treats both `NULL` and `[]` as full access.
- **Risk:** An old client caches an old response shape and rejects `allowed_models` in the error body. **Mitigation:** Error body is a superset of the OpenAI-compatible shape; extra fields are ignored.
- **Risk:** Performance regression on the proxy hot path. **Mitigation:** One additional indexed-by-PK SQLite read (`SELECT allowed_models_json FROM key_policies WHERE key_id = ?`) per request. Existing path already runs two interceptors (`keyAccess`, `quota`) so the overhead is negligible. If profiling shows it matters, fold the column read into a small per-key cache similar to `apiKeyCache`.
- **Risk:** Rework if the operator later wants the inverse (blocklist). **Mitigation:** Interceptor is the only enforcement point; switching semantics is a localised change to `readAllowedModels` and the admin UI.

## Future extensions (not in this spec)

- Glob / regex support in whitelist entries.
- Per-key blocklist (in addition to whitelist).
- Caching `allowedModels` alongside the `apiKeyCache` lookup result to avoid the extra SELECT.
- Surfacing the effective whitelist in `/api/public/key-check` (decide on privacy trade-off first).
