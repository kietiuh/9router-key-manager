# Clear Key Usage History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-key "Clear usage history" button in the admin KeyDrawer that wipes the key's `usage_events` rows from SQLite (with VACUUM) after a single confirmation dialog, replacing the manual `npx tsx scripts/ops/clean-key-usage.ts --apply` workflow.

**Architecture:** Mirror the existing `POST /api/keys/:keyId/reset-window` pattern. New backend route does `DELETE FROM usage_events WHERE api_key = ?` in a `db.transaction()`, runs `VACUUM` outside the transaction (SQLite rule), writes an `audit_log` row, invalidates caches. Frontend adds a `clearUsage()` handler in `Dashboard.tsx` and a new button in `KeyDrawer.tsx`, both gated by `window.confirm()`.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React. No new dependencies. No schema changes.

**Spec:** `docs/superpowers/specs/2026-08-15-clear-key-usage-design.md`

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/server/routes/admin.ts` | Modify (insert handler) | New `POST /api/keys/:keyId/clear-usage` route |
| `src/client/Dashboard.tsx` | Modify (add handler + pass prop) | New `clearUsage(k)` function; pass `onClearUsage` to KeyDrawer |
| `src/client/KeyDrawer.tsx` | Modify (accept prop, add button) | Render new button in `.actions` div |
| `src/client/i18n.ts` | Modify (add 2 keys × 2 langs) | Add `clearUsage` + `clearUsageConfirm` to `en`/`vi` |

No new files, no new tests, no new schema migrations. The project has no existing admin-route tests (verified — only `src/bot/*.test.ts` and `src/server/services/watcher.test.ts` exist), so this plan follows project convention and ships manual smoke tests instead.

---

## Global Constraints

- **No new dependencies.** Use only `better-sqlite3`, Fastify, React patterns already in the codebase.
- **No schema changes.** Use existing `usage_events` and `audit_log` tables.
- **VACUUM must run outside the transaction.** SQLite forbids `VACUUM` inside a transaction; the `clean-key-usage.ts` CLI does the same.
- **Confirmation is mandatory.** Use the same `window.confirm()` pattern as `resetWindow` in `Dashboard.tsx:138-143`.
- **Audit log entry is mandatory.** Use `action = 'usage.clear'`. Mirror the pattern from `admin.ts:230-231` (`window.reset`).
- **Cache invalidation is mandatory.** Call `invalidateApiKeyCache()` and `invalidateUsageSummaryCache()` after the delete, mirroring `admin.ts:232-233`.
- **Branch:** All commits land on `feat/clear-key-usage`, branched from `main`.
- **Deploy:** After merge to main, restart `9router-key-manager.service` in **one** Bash tool call combining stop + start (`sudo systemctl restart ...` or chained commands — per the user's restart-as-one-command rule).

---

## Task 1: Add `clear-usage` backend route

**Files:**
- Modify: `src/server/routes/admin.ts` (insert after the `reset-window` handler at line 235, before `POST /api/watcher/run`)

**Interfaces:**
- Consumes: existing `AdminRouteOptions` — uses `db`, `requireAuth` (via `protectedRoutes` hook), `lookupApiKeyById`, `invalidateApiKeyCache`, `invalidateUsageSummaryCache`.
- Produces: route `POST /api/keys/:keyId/clear-usage` that returns `{ ok: true, keyId, deleted, vacuumed }` on success, `{ error: 'key not found' }` with HTTP 404 on missing key.

- [ ] **Step 1: Locate the insertion point**

Open `src/server/routes/admin.ts` and find the `reset-window` handler that ends at line 235 (the `return mutationOk(keyId);` line). The new handler goes immediately after that closing `});` and before the `protectedRoutes.post('/api/watcher/run', ...)` line.

- [ ] **Step 2: Insert the handler**

Add this block immediately after the `reset-window` handler's closing `});`:

```typescript
    protectedRoutes.post('/api/keys/:keyId/clear-usage', async (req, reply) => {
      const { keyId } = req.params as { keyId: string };
      const apiKey = lookupApiKeyById(keyId);
      if (!apiKey) return reply.code(404).send({ error: 'key not found' });
      const deleted = db.transaction(() => {
        const res = db.prepare('DELETE FROM usage_events WHERE api_key = ?').run(apiKey);
        return Number(res.changes || 0);
      })();
      let vacuumed = true;
      try {
        db.exec('VACUUM');
      } catch {
        vacuumed = false;
      }
      db.prepare('INSERT INTO audit_log (key_id, action, message) VALUES (?, ?, ?)').run(
        keyId,
        'usage.clear',
        JSON.stringify({ deleted, vacuumed }),
      );
      invalidateApiKeyCache();
      invalidateUsageSummaryCache();
      return { ok: true, keyId, deleted, vacuumed };
    });
```

- [ ] **Step 3: Type-check the file**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "(admin\.ts|error)" | head -20`

Expected: empty output (no errors). If you see `admin.ts:NNN: error ...`, fix the typo and re-run.

- [ ] **Step 4: Build the client bundle to confirm nothing downstream broke**

Run: `npm run build 2>&1 | tail -20`

Expected: success. (Backend-only change should compile cleanly without touching client code yet.)

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/admin.ts
git commit -m "feat(server): add POST /api/keys/:keyId/clear-usage endpoint

Deletes all usage_events rows for the key inside a transaction, runs
VACUUM (outside the transaction per SQLite rules), and writes an
audit_log entry with action 'usage.clear'. Invalidates api-key and
usage-summary caches so the dashboard reflects the wipe immediately.

Mirrors the existing reset-window pattern.
"
```

---

## Task 2: Add i18n strings

**Files:**
- Modify: `src/client/i18n.ts` (append 2 keys to each language dictionary)

**Interfaces:**
- Consumes: existing `dict` shape — `Record<'en' | 'vi', Record<string, string>>`.
- Produces: new keys `clearUsage` (button label) and `clearUsageConfirm` (confirm dialog text with `{name}` placeholder) for both languages.

- [ ] **Step 1: Append `clearUsage` and `clearUsageConfirm` to the `en` dictionary**

In `src/client/i18n.ts` line 8, find the long single-line English dictionary. It currently ends with `noLogs: 'No requests in this window.'`. Replace that ending with:

```typescript
noLogs: 'No requests in this window.', clearUsage: 'Clear usage history', clearUsageConfirm: 'Clear all usage history for {name}? This action cannot be undone.'
```

- [ ] **Step 2: Append the same two keys to the `vi` dictionary**

In line 11, find the Vietnamese dictionary ending with `noLogs: 'Chưa có request trong khoảng này.'`. Replace with:

```typescript
noLogs: 'Chưa có request trong khoảng này.', clearUsage: 'Xóa lịch sử sử dụng', clearUsageConfirm: 'Xóa toàn bộ lịch sử sử dụng của {name}? Thao tác này không thể hoàn tác.'
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "(i18n\.ts|error)" | head -10`

Expected: empty. The `dict` type is `as const`, so missing keys won't error at compile time but will produce `undefined` at runtime — verify the keys are present with the next step.

- [ ] **Step 4: Verify keys exist in both languages**

Run:

```bash
node -e "const { dict } = require('./src/client/i18n.ts'); console.log('en:', dict.en.clearUsage, '|', dict.en.clearUsageConfirm); console.log('vi:', dict.vi.clearUsage, '|', dict.vi.clearUsageConfirm);"
```

(Note: `.ts` won't load directly in Node — use the built bundle instead.)

Alternative if the above errors:

```bash
grep -E "clearUsage|clearUsageConfirm" src/client/i18n.ts
```

Expected: 4 matches, one per dictionary entry × 2 languages.

- [ ] **Step 5: Commit**

```bash
git add src/client/i18n.ts
git commit -m "feat(i18n): add clearUsage and clearUsageConfirm strings

- en: 'Clear usage history' / 'Clear all usage history for {name}? This action cannot be undone.'
- vi: 'Xóa lịch sử sử dụng' / 'Xóa toàn bộ lịch sử sử dụng của {name}? Thao tác này không thể hoàn tác.'
"
```

---

## Task 3: Add `clearUsage` handler in Dashboard

**Files:**
- Modify: `src/client/Dashboard.tsx` (insert `clearUsage` after `resetWindow` at line 143; pass new prop to `<KeyDrawer>` at line 154)

**Interfaces:**
- Consumes: existing `setError`, `setSaving`, `refresh`, `api` helpers; `KeyUsageSummary` type; `t.clearUsageConfirm` i18n string (from Task 2).
- Produces: `async function clearUsage(k: KeyUsageSummary): Promise<void>` that mirrors `resetWindow` but hits `POST /api/keys/${k.keyId}/clear-usage`.

- [ ] **Step 1: Insert `clearUsage` after `resetWindow`**

In `src/client/Dashboard.tsx`, find the `resetWindow` function (lines 138-143). Insert this directly after it:

```typescript
  async function clearUsage(k: KeyUsageSummary) {
    const msg = t.clearUsageConfirm.replace('{name}', k.name);
    if (!confirm(msg)) return;
    setSaving(k.keyId);
    try {
      await api(`/api/keys/${k.keyId}/clear-usage`, { method: 'POST' });
      await refresh();
    } finally {
      setSaving('');
    }
  }
```

Note: `t.clearUsageConfirm` uses a `{name}` placeholder because the key's display name may contain characters that break `confirm()` if concatenated naively (e.g. quotes, backslashes). Using `.replace('{name}', k.name)` is safe because `replace` only replaces the literal substring, never interprets the replacement as a pattern.

- [ ] **Step 2: Add `onClearUsage` prop to the `<KeyDrawer>` invocation**

At line 154, find the `<KeyDrawer ...>` JSX. It currently has these props:

```typescript
<KeyDrawer selected={selected} audit={audit} config={config} lang={lang} saving={saving} onClose={() => setSelected(null)} onQuickDaily={quickDaily} onSavePolicy={savePolicy} onResetWindow={resetWindow} onViewDetail={viewKeyDetail} />
```

Add `onClearUsage={clearUsage}` after `onResetWindow={resetWindow}`:

```typescript
<KeyDrawer selected={selected} audit={audit} config={config} lang={lang} saving={saving} onClose={() => setSelected(null)} onQuickDaily={quickDaily} onSavePolicy={savePolicy} onResetWindow={resetWindow} onClearUsage={clearUsage} onViewDetail={viewKeyDetail} />
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "(Dashboard\.tsx|error)" | head -10`

Expected: empty. (KeyDrawer's prop type mismatch will show up here if you forgot Step 2 of Task 4 yet — that's fine, we'll fix it in Task 4.)

- [ ] **Step 4: Commit (do not push yet — KeyDrawer is still broken until Task 4)**

Actually skip the commit here. The build will fail until Task 4 wires the prop on the receiving side. Continue to Task 4.

---

## Task 4: Wire button in KeyDrawer

**Files:**
- Modify: `src/client/KeyDrawer.tsx` (add `onClearUsage` prop type at line 7; add button in `.actions` div at line 28)

**Interfaces:**
- Consumes: `selected: KeyUsageSummary`, `saving: string`, `t.clearUsage` i18n string, new `onClearUsage` callback (from Task 3).
- Produces: a destructive-styled `<button>` rendered inside the existing `.actions` div, calling `onClearUsage(selected)` on click. Disabled while `saving === selected.keyId` (so concurrent clicks are blocked during the in-flight request).

- [ ] **Step 1: Extend the `KeyDrawer` prop type**

At line 7 of `src/client/KeyDrawer.tsx`, the function signature is:

```typescript
export function KeyDrawer({ selected, audit, config, lang, saving, onClose, onQuickDaily, onSavePolicy, onResetWindow, onViewDetail }: { ... })
```

Replace the parameter list (the destructured props) to add `onClearUsage`:

```typescript
export function KeyDrawer({ selected, audit, config, lang, saving, onClose, onQuickDaily, onSavePolicy, onResetWindow, onClearUsage, onViewDetail }: {
  selected: KeyUsageSummary;
  audit: Audit[];
  config: ConfigStatus | null;
  lang: Lang;
  saving: string;
  onClose: () => void;
  onQuickDaily: (k: KeyUsageSummary, limit: number) => void;
  onSavePolicy: (k: KeyUsageSummary, form: HTMLFormElement) => void;
  onResetWindow: (k: KeyUsageSummary) => void;
  onClearUsage: (k: KeyUsageSummary) => void;
  onViewDetail: (k: KeyUsageSummary) => void;
}) {
```

- [ ] **Step 2: Add the button to the `.actions` div**

At line 28, find this JSX:

```typescript
<div className="actions"><button disabled={saving === selected.keyId}>{saving === selected.keyId ? t.saving : t.save}</button><button type="button" disabled={selected.resetPolicy === 'daily' || selected.resetPolicy === 'monthly'} onClick={() => onResetWindow(selected)}>{t.resetNow}</button></div>
```

Replace the entire `<div className="actions">...</div>` with:

```typescript
<div className="actions">
        <button disabled={saving === selected.keyId}>{saving === selected.keyId ? t.saving : t.save}</button>
        <button type="button" disabled={selected.resetPolicy === 'daily' || selected.resetPolicy === 'monthly'} onClick={() => onResetWindow(selected)}>{t.resetNow}</button>
        <button type="button" className="danger" disabled={saving === selected.keyId} onClick={() => onClearUsage(selected)}>{t.clearUsage}</button>
      </div>
```

Note: the button is **always enabled** when not in-flight (no `resetPolicy` check). Clearing history is allowed regardless of policy.

- [ ] **Step 3: Type-check the full project**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`

Expected: empty. If you see errors about `onClearUsage` missing on `KeyDrawer`, re-check Task 3 Step 2 — Dashboard must pass the prop.

- [ ] **Step 4: Build the client bundle**

Run: `npm run build 2>&1 | tail -20`

Expected: success. Look for warnings about the new button or prop, fix any.

- [ ] **Step 5: Add minimal CSS for the `.danger` button class**

Find the project's stylesheet — likely `src/client/styles.css` or `src/client/index.css`. Run:

```bash
grep -l "actions" src/client/*.css src/client/**/*.css 2>/dev/null
```

Open whichever file holds `.actions` button styles and append:

```css
.actions button.danger {
  background: #c0392b;
  color: #fff;
  border-color: #c0392b;
}
.actions button.danger:hover:not(:disabled) {
  background: #a93226;
  border-color: #a93226;
}
.actions button.danger:disabled {
  background: #c0392b;
  opacity: 0.5;
}
```

If the existing stylesheet uses different colors for primary actions, mirror those instead of the literal red above. The goal is: destructive button is visually distinct from "Save" (primary) and "Reset window" (secondary), but otherwise matches the existing button chrome.

- [ ] **Step 6: Commit Tasks 3 + 4 together**

```bash
git add src/client/Dashboard.tsx src/client/KeyDrawer.tsx src/client/styles.css
git commit -m "feat(client): add Clear usage history button in KeyDrawer

- Dashboard.clearUsage(k): confirm via window.confirm, POST to
  /api/keys/:keyId/clear-usage, then refresh().
- KeyDrawer renders new destructive button next to Reset window.
  Disabled during in-flight request (saving === keyId).
- .danger button class added to stylesheet for visual distinction.
"
```

---

## Task 5: Push branch and open PR

**Files:** none — Git/GitHub operations only.

- [ ] **Step 1: Verify branch state**

Run:

```bash
git status
git log --oneline main..HEAD
```

Expected: 4 commits ahead of `main` (Tasks 1, 2, 4 — Task 3 was committed with Task 4). Working tree clean.

- [ ] **Step 2: Push the branch**

Run: `git push -u origin feat/clear-key-usage`

Expected: success. If `origin` is missing or you see "could not find remote", stop and ask the user for the correct remote name.

- [ ] **Step 3: Open a PR**

Run: `gh pr create --base main --head feat/clear-key-usage --title "feat: clear key usage history from UI" --body "$(cat <<'EOF'
Adds a per-key **Clear usage history** button to the admin KeyDrawer. The button deletes all \`usage_events\` rows for the selected key (with VACUUM), guarded by a confirmation dialog. This replaces the manual \`npx tsx scripts/ops/clean-key-usage.ts --apply\` workflow.

Spec: \`docs/superpowers/specs/2026-08-15-clear-key-usage-design.md\`

## Changes

- \`POST /api/keys/:keyId/clear-usage\` — DELETE inside a transaction, VACUUM outside (SQLite rule), audit log entry with action \`usage.clear\`, cache invalidation.
- KeyDrawer renders a new destructive-styled button next to "Reset window".
- Dashboard.clearUsage mirrors the existing resetWindow flow.
- i18n: new \`clearUsage\` and \`clearUsageConfirm\` keys in both \`en\` and \`vi\`.
- No schema changes. No new dependencies.

## Manual test

1. Open dashboard, select a key with non-zero usage.
2. Click **Clear usage history** → confirm dialog appears.
3. Cancel → no change.
4. Confirm → drawer re-renders with all stats = 0; audit log shows \`usage.clear\` entry.
5. \`sqlite3 manager.sqlite "SELECT COUNT(*) FROM usage_events WHERE api_key = '<key>'"\` returns 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"`

Expected: PR URL printed. Capture it.

- [ ] **Step 4: Report the PR URL to the user**

Stop here. Do **not** merge. The user said: *"Sau khi làm xong tạo PR vào main. Quay lại main review lại PR và restart lại để áp dụng nhé."* — they will review and merge themselves.

---

## Self-Review (run after writing the plan, before handoff)

1. **Spec coverage:**
   - Backend route with DELETE + transaction + VACUUM + audit + cache invalidation → Task 1. ✓
   - `lookupApiKeyById` 404 path → Task 1 Step 2. ✓
   - VACUUM fail returns `vacuumed: false` and audit still written → Task 1 Step 2. ✓
   - i18n keys in both languages → Task 2. ✓
   - Dashboard `clearUsage` handler with confirm → Task 3. ✓
   - `onClearUsage` prop passed to KeyDrawer → Task 3 Step 2. ✓
   - Button in `.actions` div, always enabled (no `resetPolicy` gate) → Task 4 Step 2. ✓
   - `.danger` CSS class for visual distinction → Task 4 Step 5. ✓
   - Branch + PR workflow per user instruction → Task 5. ✓
   - Restart-as-one-command noted in Global Constraints; deploy step intentionally NOT in the plan — user reviews and merges themselves per their stated workflow. ✓

2. **Placeholder scan:** No "TBD", "TODO", "implement later", "appropriate", or "similar to" markers.

3. **Type consistency:** `clearUsage` referenced as both function name (Dashboard) and prop name (KeyDrawer) consistently. `onClearUsage` prop name consistent across Dashboard and KeyDrawer. `k.keyId` used for `saving` flag in both Dashboard handlers — consistent with existing `savePolicy` pattern at line 80-91.

4. **Test gap acknowledgment:** The project has no existing admin-route tests (`src/server/routes/admin.ts` is not covered by any `*.test.ts`). The spec explicitly accepts manual smoke tests. Task 1 deliberately does not add a route test to avoid inventing new test infrastructure for a single endpoint. Manual smoke checklist is in the PR body.
