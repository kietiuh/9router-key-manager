# Per-key Request Logs Panel — Design

**Date:** 2026-07-13
**Status:** Approved for planning
**Branch:** `feat/key-request-logs`
**Deploy target:** production key-manager on the gocinema VPS (systemd unit `9router-key-manager.service`)

## Goal

On the `/key/:id` detail page, add a paginated, filterable panel that lists **every logged request** for the key directly from the SQLite `usage_events` table. The panel must include cache token columns so operators can see at a glance how much of their key traffic is hitting cache. This complements the existing per-model aggregate table without changing it.

Note on duplicates: `usage_events.signature` is `UNIQUE` and ingestion uses `INSERT OR IGNORE`, so the panel never sees duplicate rows. The originally proposed "Dup" badge is therefore dropped.

## Motivation

Operators currently see per-key totals and per-model aggregates, but cannot answer simple questions like "what exactly did this key call in the last hour, with what cache hit rate". The data already lives in `usage_events`; the panel only surfaces it. Cache tokens are the most-requested missing field — they are visible in traffic-log JSON lines but not in any structured UI.

## Out of scope

- Streaming / SSE updates of new rows. Initial release: user-driven refresh only.
- CSV/JSON export of logs.
- Cross-key log search.
- Editing or deleting log rows.
- A "Show all" button — fixed 30-day default + a custom range picker.
- Hit ratio column — cache read vs read+non-cache would be a future metric, not in this release.

## Non-goals

- Changing the schema of `usage_events`. The required columns already exist.
- Changing the existing `/api/keys/usage` summary response.
- Changing the per-model aggregate table on the same page.

## Data model

No schema changes. The `usage_events` table already provides everything:

| Column used | Type | Purpose |
| --- | --- | --- |
| `api_key` | TEXT | filters by key (indexed via `idx_usage_events_key_time`) |
| `id` | INTEGER PK | tie-breaker for cursor |
| `timestamp` | TEXT | sort key + range filter |
| `signature` | TEXT UNIQUE | ingestion deduplication key; duplicate rows never enter this table |
| `model`, `provider`, `connection_id` | TEXT | display columns |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | INTEGER | display columns |
| `cache_read_input_tokens`, `cache_creation_input_tokens` | INTEGER | the two cache columns |
| `cost` | REAL | display column |

No new index is added. `idx_usage_events_key_time (api_key, timestamp)` already covers the keyset query; queries that also filter by `model` or `provider` fall back to the `(api_key, timestamp)` index with a small `WHERE` filter, which the planner handles fine for the bounded windows we use.

## Service: `usageEventsList`

New file: `src/server/services/usageEventsList.ts`. It mirrors the shape of `usageStore.ts`.

Public API:

```ts
export type UsageEventRow = {
  id: number;
  timestamp: string;
  model: string | null;
  provider: string | null;
  connectionId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cost: number | null;
};

export type UsageEventsQuery = {
  apiKey: string;
  fromIso: string;
  toIso: string;
  model?: string | null;
  provider?: string | null;
  cache?: 'any' | 'read' | 'write' | 'none';
  cursor?: { ts: string; id: number } | null;
  pageSize: 50 | 100 | 200;
};

export type UsageEventsPage = {
  rows: UsageEventRow[];
  nextCursor: { ts: string; id: number } | null;
  hasMore: boolean;
};

export function listUsageEventsForKey(db: Database.Database, query: UsageEventsQuery): UsageEventsPage;

export function parseCursor(input?: string | null): { ts: string; id: number } | null;
export function encodeCursor(c: { ts: string; id: number }): string;
export function defaultRange(): { fromIso: string; toIso: string };
```

### Query strategy

Sort `DESC` by `(timestamp, id)` so the user sees the newest events first.

```sql
SELECT id, timestamp, signature, model, provider, connection_id,
       prompt_tokens, completion_tokens, total_tokens,
       cache_read_input_tokens, cache_creation_input_tokens, cost
FROM usage_events
WHERE api_key = ?
  AND timestamp >= ? AND timestamp <= ?
  AND (? IS NULL OR model = ?)
  AND (? IS NULL OR provider = ?)
  AND (
    ? = 'any' OR
    (? = 'read'  AND cache_read_input_tokens     > 0) OR
    (? = 'write' AND cache_creation_input_tokens > 0) OR
    (? = 'none'  AND COALESCE(cache_read_input_tokens, 0) = 0
                  AND COALESCE(cache_creation_input_tokens, 0) = 0)
  )
  AND (timestamp < ? OR (timestamp = ? AND id < ?))
ORDER BY timestamp DESC, id DESC
LIMIT ?;
```

Duplicate handling requires no query work: the `signature` column is unique and ingestion uses `INSERT OR IGNORE`, so every returned row is already unique.

### Cursor format

`encodeCursor({ ts, id })` = base64url of `<ts>|<id>`. `parseCursor` validates that the decoded form is `<ISO>|<positive integer>`. Invalid cursors make the endpoint return HTTP 400; silently resetting would hide broken links and could show an unexpected first page.

### `defaultRange()`

```ts
const to = new Date();
const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
return { fromIso: from.toISOString(), toIso: to.toISOString() };
```

Both endpoints are bounded — the panel never returns data older than the requested window.

## Admin API

New route, registered alongside the existing `/api/keys/usage` in `src/server/routes/admin.ts`:

```
GET /api/keys/:keyId/usage-events
  protected: yes (uses preHandler requireAuth)
  query:
    from: ISO          (default = defaultRange().fromIso)
    to:   ISO          (default = defaultRange().toIso)
    model: string?     (exact match)
    provider: string?  (exact match)
    cache: any|read|write|none  (default = any)
    cursor: string?    (encoded cursor)
    pageSize: 50|100|200       (default = 50, anything else → 400)
  404: key policy not found
  400: invalid from/to/cursor/pageSize
```

Validation uses `zod`. `AdminRouteOptions` gains `lookupApiKeyById: (keyId: string) => string | null`. `createServerApp` wires it to `apiKeyCache.getKeys().find(k => k.id === keyId)?.key ?? null`. This uses the existing 5-second key cache and does not expose the raw key in the response. If not found, return 404.

Response shape (zod-validated server-side):

```ts
{
  rows: UsageEventRow[],
  nextCursor: string | null,
  hasMore: boolean,
}
```

Server pulls `pageSize + 1` rows. If it gets `pageSize + 1`, the last is dropped and `hasMore = true`, `nextCursor = encodeCursor(lastKeptRow)`.

Also new: `GET /api/keys/:keyId/usage-events/models` returns `string[]` of distinct model names in the same default window — used by the model filter dropdown. Capped at 200 entries to keep response small.

### Invalidation

The endpoint reads only `usage_events`. It does **not** participate in `usageSummaryCache`, so no cache plumbing is needed. SQLite reads are direct and bounded.

## Shared types

`src/shared/types.ts` gains:

```ts
export type UsageEventLogRow = {
  id: number;
  timestamp: string;
  model: string | null;
  provider: string | null;
  connectionId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cost: number | null;
};

export type UsageEventsLogResponse = {
  rows: UsageEventLogRow[];
  nextCursor: string | null;
  hasMore: boolean;
};
```

The same type is also re-exported from `usageEventsList.ts` for the server-side callers, mirroring the `storedUsageSelect` pattern.

## Client

### New component: `src/client/RequestLogsPanel.tsx`

Props: `{ keyId: string; lang: Lang }`. The component owns its own state for:

- `filters`: `{ from, to, model, provider, cache, pageSize }`
- `page`: server response
- `history`: stack of `{ response, filters, label }` items used by Prev/Next (the cursor is the sole key). Stack stays small — Prev restores the previous filters + cursor in one step.
- `loading`, `error`.

UI:

- **Filter bar** (one row, wraps on mobile):
  - Time range chips: `7d` / `30d` / `90d` / `Custom`. `Custom` reveals two `<input type="datetime-local">` fields converted via `fromVnInput` / `toVnInput` to UTC ISO, mirroring `proxy.ts` and the dashboard's audit log filter.
  - Model dropdown populated from `GET /api/keys/:keyId/usage-events/models`. Empty option = "all".
  - Cache dropdown: All / Read > 0 / Write > 0 / None.
  - Provider text input (small).
  - Page size dropdown: 50 / 100 / 200.
  - Refresh button (re-runs from first page).

- **Table** (`section.tableWrap`):

  | Column | Source | Notes |
  | --- | --- | --- |
  | Time | `vnDateTime(row.timestamp)` | mirror existing usage format |
  | Model | `<code>{row.model}</code>` | `—` if null |
  | Prompt | `fmt(row.promptTokens)` | |
  | Completion | `fmt(row.completionTokens)` | |
  | Total | `fmt(row.totalTokens)` | |
  | Cache Read | `fmt(row.cacheReadTokens)` | **`—` when null** |
  | Cache Write | `fmt(row.cacheCreationTokens)` | **`—` when null** |
  | Cost | `$${row.cost.toFixed(6)}` | `—` if null |
  | Provider/Connection | `${provider ?? '—'}${connectionId ? ` · ${connectionId}` : ''}` | |


- **Pager**: `← Prev` / `Next →` buttons. Disabled at stack boundaries. Tiny label: "Showing N rows". Total-in-range is **not** displayed because computing it would scan the whole window.

- **Initial fetch**: `defaultRange()` (last 30d), no cursor, `pageSize = 50`, cache = any, model/provider empty.

- **Errors**: rendered inside the panel via `pre.error` — does not affect the existing per-model section above.

### `KeyDetailPage.tsx`

Below the `<h2>{t.models}</h2>` section, add `<RequestLogsPanel keyId={keyId} lang={lang} />`. The existing aggregate remains unchanged.

### i18n (`src/client/i18n.ts`)

Add to both `en` and `vi`:

- `requestLogs` (header)
- `cache` (column header)
- `cacheRead`, `cacheWrite`
- `cacheAll`, `cacheReadOnly`, `cacheWriteOnly`, `cacheNone`
- `range7d`, `range30d`, `range90d`, `rangeCustom`
- `from`, `to`
- `prev`, `next`
- `refresh`, `loading`, `error`
- `noLogs`, `filters`

### CSS (`src/client/style.css`)

Additions only — no rule changes elsewhere:

```css
.logsFilters { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
.logsFilters label { display: flex; flex-direction: column; font-size: 0.85em; gap: 2px; }
.logsFilters input, .logsFilters select { min-width: 8em; }
.pager { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
```

## Files touched

### New

- `src/server/services/usageEventsList.ts`
- `src/server/services/usageEventsList.test.ts`
- `src/client/RequestLogsPanel.tsx`
- `src/client/RequestLogsPanel.test.tsx`

### Modified

- `src/server/routes/admin.ts` — register the two GET routes, accept `db` + `lookupApiKey` (already available via the existing service wiring; need to add a small wrapper around `apiKeyCache.getKeys()`).
- `src/shared/types.ts` — add the two exported types.
- `src/client/i18n.ts` — add new strings.
- `src/client/KeyDetailPage.tsx` — render `<RequestLogsPanel>` below models.
- `src/client/style.css` — add the small style block.

## Testing

### Unit — `usageEventsList.test.ts`

Mirror the structure of `usageStore.test.ts`:

- `parseCursor` / `encodeCursor` round-trip and reject malformed input.
- `defaultRange()` returns a 30d window.
- `listUsageEventsForKey`:
  - Sorts by `timestamp DESC, id DESC`.
  - Cursor at `(lastTs, lastId)` returns strictly older rows.
  - `model` / `provider` filters apply.
  - `cache: read|write|none` filters apply.
  - `nextCursor` present when more rows exist, `null` on last page.
  - `pageSize` enforced (`50/100/200`).
- `EXPLAIN QUERY PLAN` confirmed uses `idx_usage_events_key_time` for the key+range query (asserted in the test where viable).

### Integration — `app.test.ts`

Add a block that signs in, then:

- `GET /api/keys/:keyId/usage-events` returns rows in DESC order, with cache columns populated for seeded data.
- `GET /api/keys/:keyId/usage-events?cache=read` filters correctly.
- `GET /api/keys/:keyId/usage-events?pageSize=200` accepted; `pageSize=999` rejected with 400.
- `GET /api/keys/:keyId/usage-events?from=not-iso` rejected with 400.
- `GET /api/keys/:keyId/usage-events/models` returns distinct models.
- Unauthenticated request returns 401.

Seed helpers can be added next to existing fixtures — small, in-memory, no fixtures shared with the production DB.

### Component — `RequestLogsPanel.test.tsx`

Mock `global.fetch` (already done in `api.test.ts`):

- Renders initial 50 rows from a fixture.
- Clicking `Custom` reveals the date inputs.
- Changing `pageSize` resets to first page.
- Clicking `Next` calls with `cursor=...` and renders the new page.
- Clicking `Prev` after Next restores the previous page (no `cursor`).
- Server error renders in the panel `pre.error` and does not unmount.

Existing `keyDetail.test.ts` must continue to pass — no changes to `KeyDetailPage`'s contract for the aggregate section.

## Deploy

Production has live traffic. Plan:

1. Cut branch `feat/key-request-logs` from `main`. Do all work there.
2. Run `npm test`, `npm run lint`, `npm run build` on the branch until clean.
3. Push branch and open PR into `main`.
4. Self-review the PR using the `code-review` skill. Apply any findings that survive verification.
5. Merge (squash or fast-forward — use whatever the repo convention is; default here is fast-forward or no-ff merge for clarity). Do **not** delete the branch before the smoke test passes.
6. On the VPS:

   ```bash
   cd /home/ubuntu/9router-key-manager
   git pull --ff-only
   npm ci --omit=dev && npm run build   # ensures dist/ is built before service restart
   sudo systemctl restart 9router-key-manager.service
   sudo systemctl status 9router-key-manager.service --no-pager
   ```

   Restart is a single process bounce — expected downtime is the time systemd takes to stop+start the Node process, typically 2–5 seconds.

7. After restart, smoke test:
   - `curl -sS http://127.0.0.1:20128/api/health` (or the configured port — actual port discovered via `systemctl show 9router-key-manager.service -p ExecStart` if needed).
   - `curl -sS -b admin_session=ok http://127.0.0.1:PORT/api/keys/<known-key>/usage-events | jq '.rows | length'`.
   - Open `/key/<keyId>` in the admin UI and confirm the new panel renders without errors.
   - Tail `journalctl -u 9router-key-manager.service -n 200` for unexpected errors.

8. If smoke test fails: revert the merge with `git reset --hard HEAD~1` and restart. If `dist/` is the served path, also rebuild to roll back. The service is small, fast to redeploy, and the change is additive — no schema change, so a partial rollback is safe.

## Risks & mitigations

- **Risk:** Cursor stale when data is appended between page loads. **Mitigation:** cursor identifies a position (timestamp, id); rows inserted after the cursor are simply newer and shown only when paginating `Next` from the first page; the user never sees a duplicate or a missed row across page boundaries within the same window.
- **Risk:** `EXPLAIN QUERY PLAN` reveals a full scan on `provider` / `model` filter. **Mitigation:** window is 30d and the WHERE on `(api_key, timestamp)` already narrows heavily; remaining rows are bounded by `pageSize + 1`. If a future key has massive volume we can add covering indexes — deferred until measured.
- **Risk:** Adding latency to key-detail page first paint. **Mitigation:** the new panel issues its own fetch in a `useEffect`; the existing aggregate render is unaffected. We do not wait for logs before showing the aggregate.
- **Risk:** `npm ci --omit=dev` failing mid-deploy. **Mitigation:** the service already runs without dev deps (it's `tsx` from production deps), and the build runs in the same shell command. We rebuild `dist/` so the static SPA reflects the new panel.
- **Risk:** Forgetting to refresh `dist/` after frontend changes. **Mitigation:** `npm run build` is part of the deploy block above. The service serves `dist/web/` when it exists (`app.ts` checks `fs.existsSync(webRoot)`).

## Future extensions (not in this spec)

- WebSocket / SSE push for new rows.
- CSV / JSONL export.
- Cross-key search ("which key called model X in the last hour").
- Saving filter presets.
- A "saving filter changes the dashboard's defaults" toggle.
