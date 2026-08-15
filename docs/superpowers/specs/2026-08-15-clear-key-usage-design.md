# Clear Key Usage History from UI — Design

**Date:** 2026-08-15
**Status:** Approved for planning
**Branch:** `feat/clear-key-usage`
**Deploy target:** production key-manager on the gocinema VPS (systemd unit `9router-key-manager.service`)

## Goal

Add a **"Clear usage history"** action to each key inside the existing admin dashboard, so operators can wipe `usage_events` rows for a single key without SSHing into the server and running `scripts/ops/clean-key-usage.ts` by hand. The action is destructive, must always require a confirmation step, and must always run `VACUUM` afterwards so the SQLite file actually shrinks.

This is the in-app twin of `scripts/ops/clean-key-usage.ts`. The CLI script remains available for batch/scheduled use; this design only adds a UI surface for the same operation.

## Motivation

`usage_events` grows without bound — a single noisy key can accumulate tens of thousands of rows (25,858 was observed for one key on 2026-08-15). The watcher only advances the `key_policies.window_start`, it does not delete rows. When a key's history is no longer useful (debug finished, test data, misconfigured model rewriting), the operator currently has to:

1. SSH into the VPS.
2. Find the SQLite path (default `~/.local/state/9router-key-manager/manager.sqlite`).
3. Optionally back up the DB.
4. Run `npx tsx scripts/ops/clean-key-usage.ts --key <key> --apply`.

That's four manual steps for a common one-off task. Bringing it into the dashboard (next to the existing "Reset window" button) collapses it to a click + confirm.

## Out of scope

- Bulk clear (clear multiple keys in one action). Single-key only.
- Time filters / `keep-last N` options in the UI. The UI always deletes all rows for the key, matching the user's stated preference.
- A separate `VACUUM` toggle in the UI. Server always runs `VACUUM` after delete.
- Confirm message that previews the row count. The confirm message is fixed text (mirroring `reset-window`'s simple confirm).
- Refactoring `scripts/ops/clean-key-usage.ts` to share code with the new endpoint. Out of scope; can be a follow-up.

## Non-goals

- Changing the `usage_events` schema.
- Exposing the action via the Telegram bot.
- Adding the action to the `/key/:id` detail page. Only the KeyDrawer gets the button.

## User-facing behavior

Inside the KeyDrawer (the right-side panel that opens when an admin selects a key from the "Keys" tab), a new button **"Clear usage history"** appears next to the existing **"Reset manual/custom window"** button.

Click flow:

1. Browser shows a native `window.confirm()` dialog: *"Clear all usage history for {key.name}? This action cannot be undone."*
2. If the operator cancels — nothing happens.
3. If the operator confirms — the UI POSTs to the new endpoint, shows a small "Clearing…" state on the button, then `refresh()` reloads `/api/keys/usage` so the drawer's stats, the per-key table, and the audit log all reflect the cleared state.

The endpoint always deletes every row in `usage_events` for the key and always runs `VACUUM`. There is no option to keep recent rows or limit by age from the UI.

## Architecture

### Backend — new endpoint

A new route registered in `src/server/routes/admin.ts`, inside the same `protectedRoutes` block as `reset-window`:

```
POST /api/keys/:keyId/clear-usage
```

Handler flow (mirrors `reset-window` pattern):

1. `requireAuth` is already applied by `protectedRoutes.addHook('preHandler', requireAuth as any)` — no extra check needed.
2. Look up the API key string via `lookupApiKeyById(keyId)`. If null → reply 404 `{ error: 'key not found' }` (same as the existing `usage-events` route).
3. Inside `db.transaction(() => { ... })()`:
   - `DELETE FROM usage_events WHERE api_key = ?` and capture `res.changes` as `deleted`.
4. Try `db.exec('VACUUM')` — **outside** the transaction, because SQLite forbids `VACUUM` inside a transaction. Wrap in try/catch so a VACUUM failure does not abort the request after the DELETE has already succeeded.
5. `INSERT INTO audit_log (key_id, action, message) VALUES (?, 'usage.clear', ?)` where `message` is `JSON.stringify({ deleted, vacuumed })` — `vacuumed` is the boolean reflecting whether step 4 succeeded.
6. Call `invalidateApiKeyCache()` and `invalidateUsageSummaryCache()` so subsequent reads see the wiped stats.
7. Return `{ ok: true, keyId, deleted, vacuumed }`.

The DELETE is keyed on the full `api_key` string, matching the `clean-key-usage.ts` script's behavior (`api_key = ? OR api_key LIKE ?` is **not** used — the UI always operates on the full key resolved through the existing `lookupApiKeyById` mapping, so prefix matching is unnecessary and would be unsafe).

### Frontend — new button + handler

`src/client/Dashboard.tsx`:

- Add a `clearUsage(k: KeyUsageSummary)` function next to `resetWindow` (line 138). It calls `window.confirm()` with a localized message, then `POST /api/keys/${k.keyId}/clear-usage`, then `refresh()`.
- Pass `onClearUsage` to `KeyDrawer` (new prop).
- Add a `saving` flag (`saving === 'clear-usage-' + k.keyId` is awkward, so reuse the existing `saving` string by setting it to `k.keyId` while the request is in flight — same pattern as `savePolicy`).

`src/client/KeyDrawer.tsx`:

- Add a new prop `onClearUsage: (k: KeyUsageSummary) => void`.
- In the existing `.actions` div (line 28), add a second `<button type="button" onClick={() => onClearUsage(selected)}>` labeled with the new i18n key `t.clearUsage`.
- The new button is **always enabled** — there is no `resetPolicy` restriction like the "Reset window" button has, because clearing history is independent of the policy.
- Style: the existing "Reset manual/custom window" button is a regular `<button>`. The "Clear usage history" button uses the same shape but with `className="danger"` so CSS can color it red and operators can tell at a glance that it's destructive.

`src/client/i18n.ts`:

- Add `clearUsage: 'Clear usage history'` (en) and `clearUsage: 'Xóa lịch sử sử dụng'` (vi).
- Add `clearUsageConfirm: 'Clear all usage history for {name}? This action cannot be undone.'` (en) and `'Xóa toàn bộ lịch sử sử dụng của {name}? Thao tác này không thể hoàn tác.'` (vi).

## Components

| File | Change |
| --- | --- |
| `src/server/routes/admin.ts` | Add `POST /api/keys/:keyId/clear-usage` handler inside `protectedRoutes` block, immediately after the existing `reset-window` handler (line 235). |
| `src/client/Dashboard.tsx` | Add `clearUsage(k)` function. Pass `onClearUsage={clearUsage}` to `<KeyDrawer>`. |
| `src/client/KeyDrawer.tsx` | Accept new `onClearUsage` prop. Render new button in `.actions` div. |
| `src/client/i18n.ts` | Add `clearUsage` and `clearUsageConfirm` strings to both `en` and `vi` dictionaries. |
| `src/client/adminTypes.ts` (if it exists) | No change. |

No new files. No schema changes. No new dependencies.

## Data flow

```
Operator clicks "Clear usage history" in KeyDrawer
       │
       ▼
Dashboard.clearUsage(k)
  ├─ const msg = t.clearUsageConfirm.replace('{name}', k.name)
  ├─ if (!window.confirm(msg)) return
  ├─ setSaving(k.keyId)
  ├─ try { await api(`/api/keys/${k.keyId}/clear-usage`, { method: 'POST' }) }
  ├─ finally { setSaving(''); refresh() }
       │
       ▼
POST /api/keys/:keyId/clear-usage  (protectedRoutes → requireAuth)
       │
       ▼
admin.ts handler
  ├─ lookupApiKeyById(keyId) → 404 if missing
  ├─ db.transaction:
  │    └─ DELETE FROM usage_events WHERE api_key = ?  → res.changes
  ├─ db.exec('VACUUM')
  ├─ INSERT audit_log (key_id, 'usage.clear', JSON {deleted, vacuumed})
  ├─ invalidateApiKeyCache()
  ├─ invalidateUsageSummaryCache()
  └─ return { ok: true, keyId, deleted }
       │
       ▼
refresh() → GET /api/keys/usage  →  drawer's selected key now has stats = 0
       │
       ▼
New audit entry "usage.clear" appears in the KeyDrawer's audit list
```

## Error handling

| Scenario | Behavior |
| --- | --- |
| Key not found | 404 `{ error: 'key not found' }`. UI surfaces via existing `setError()` banner (no change needed — same pattern as other endpoints). |
| `better-sqlite3` throws (DB locked, IO error) | Error propagates → Fastify 500. UI surfaces via `setError()`. The DELETE may have partially succeeded; the audit row is **not** written in this case (it lives after the transaction). |
| `VACUUM` fails after a successful DELETE | Audit row still written with `{ deleted, vacuumed: false }`. The handler does **not** throw — it returns `{ ok: true, keyId, deleted, vacuumed: false }` so the UI can show the partial-success state if it wants. UI surfaces the error, but the data IS deleted. Operator can re-run `VACUUM` manually (`sqlite3 manager.sqlite 'VACUUM'`) if disk reclaim matters. |
| User cancels confirm dialog | No API call. No side effect. |
| Concurrent clears on the same key | `better-sqlite3` serializes via SQLite's locking; second request waits for first to finish, then finds 0 rows to delete (`deleted: 0`). No corruption. |
| Watcher running concurrently | Watcher uses a separate `Database` connection in some code paths; better-sqlite3 handles cross-connection locking. Worst case: watcher inserts a new row after our DELETE — that row stays (we only delete what existed at the time of the request). This matches `clean-key-usage.ts` semantics. |

No new error states introduced beyond what `reset-window` already has.

## Testing

### Unit / integration

- **Endpoint**: in the existing test pattern (if `admin.ts` has a route test, add one; if not, skip per the project's conventions). At minimum, a manual smoke test:
  - `curl -X POST -b cookies.txt http://localhost:PORT/api/keys/<keyId>/clear-usage` returns `{ ok: true, deleted: N }`.
  - Verify with `sqlite3 manager.sqlite "SELECT COUNT(*) FROM usage_events WHERE api_key = '<key>'"` that count is 0.
  - Verify `audit_log` has a row with `action = 'usage.clear'`.
  - Verify `VACUUM` ran by checking that `manager.sqlite` size on disk did not increase.
- **UI smoke**: click the button → confirm → drawer stats drop to 0 → audit entry appears.

### Manual test checklist

1. Open the dashboard, click a key with non-zero usage.
2. Verify the "Clear usage history" button is visible next to "Reset manual/custom window".
3. Click it, then click **Cancel** in the confirm dialog — nothing changes.
4. Click it again, click **OK** — drawer re-renders with `total = 0`, `cost = $0.000000`, etc.
5. Reload the page — stats are still 0 (cache invalidation worked).
6. Open `/api/audit` (or the audit panel) — the most recent entry for this key is `usage.clear` with the deleted count in its message.
7. SSH into the VPS and `sqlite3 ... "SELECT COUNT(*) FROM usage_events WHERE api_key = '<key>'"` → 0.
8. Restart the dashboard's auto-refresh — no 500s, no errors.

No automated test framework changes. No new fixtures.

## Deployment & rollout

1. Cut branch `feat/clear-key-usage` from `main`.
2. Implement, commit, push.
3. Open PR → `main`.
4. After review and merge, **deploy in a single tool call** that combines stop + start (per the user's restart-as-one-command preference) of `9router-key-manager.service`.
5. Verify the dashboard loads and the new button renders.

## Open questions

None at design time.
