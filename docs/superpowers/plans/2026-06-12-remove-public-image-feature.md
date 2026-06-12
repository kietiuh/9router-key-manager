# Remove Public Image Feature Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
**Goal:** Xóa hoàn toàn public image feature, image proxy config/stats, client `/images` page, docs/env, và cleanup related tests.
**Architecture:** Teardown focused: remove routes/services/tests/docs by feature block without dropping DB schema now.
**Tech Stack:** Fastify, React, vitest, SQLite, Node.js, markdown docs.

### Task 1: Server route cleanup
**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/routes/proxy.ts`
- Modify: `src/server/routes/admin.ts`
- Modify: `src/client/main.tsx`
- Modify: `src/client/Dashboard.tsx`
- Remove: `src/server/routes/publicImages.ts`
- Remove: `src/server/services/publicImage.ts`
- Remove: `src/server/services/publicImageJobs.ts`
- Remove: `src/server/services/publicImageStore.ts`
- Remove: `src/server/services/imageProxy.ts`

- [ ] **Step 1: Update server app imports and tests**
Edit `src/server/app.ts`:
```ts
 export async function createServerApp(options: ServerAppOptions = {}) {
+export async function createServerApp(options: ServerAppOptions = {}) {

```
Add test guard in `src/server/app.test.ts`:
```ts
-it('reads image proxy endpoints', async () => {
+it('does not register image proxies endpoints', async () => {
 ...
-const imageRes = await app.inject({ method: 'GET', url: '/api/image-proxy/config' });
-expect(imageRes.statusCode).toBe(200);
+const imageRes = await app.inject({ method: 'GET', url: '/api/image-proxy/config' });
+expect(imageRes.statusCode).toBe(404);
```

- [ ] **Step 2: Remove public image routes registration and service cleanup**
Edit `src/server/app.ts` lines between the imports and routes.

- [ ] **Step 3: Remove public route tests**
Run: `rm src/server/routes/publicImages.test.ts`

- [ ] **Step 4: Update admin route tests**
Ensure `src/server/routes/admin.test.ts` fails on `/api/images/usage` and `/api/image-proxy/config`. Add snippet:
```ts
-const imageRes = await app.inject({ method: 'GET', url: '/api/images/usage' });
-expect(imageRes.statusCode).toBe(200);
+const imageRes = await app.inject({ method: 'GET', url: '/api/images/usage' });
+expect(imageRes.statusCode).toBe(404);
```

- [ ] **Step 5: Commit server cleanup**
Run:
```bash
git add src/server/app.ts src/server/app.test.ts src/server/routes/admin.ts src/server/routes/admin.test.ts src/server/routes/publicImages.ts src/server/services/publicImage.ts src/server/services/publicImageJobs.ts src/server/services/publicImageStore.ts src/server/services/imageProxy.ts src/server/services/imageProxy.test.ts
git commit -m "chore: remove server image routes and related services"
```

### Task 2: Client cleanup
**Files:**
- Modify: `src/client/main.tsx`
- Modify: `src/client/Dashboard.tsx`
- Modify: `src/client/AdminRouting.tsx`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Remove image page component import/route**
Edit `src/client/main.tsx`:
```ts
-import { ImageCreator } from './ImageCreator';
```

- [ ] **Step 2: Remove dashboard image fetch/UI**
Replace `api<ImageUsageSummary>` fetch in `src/client/Dashboard.tsx` with a placeholder to keep array lengths aligned.

- [ ] **Step 3: Remove image proxy UI**
Remove `<section>` block labeled "Image proxy routing" from `src/client/AdminRouting.tsx`.

- [ ] **Step 4: Remove isolated image types**
Remove `ImageUsageSummary` related exports in `src/shared/types.ts`.

- [ ] **Step 5: Remove creator component and its tests**
Run:
```bash
rm src/client/ImageCreator.tsx
```

- [ ] **Step 6: Commit client cleanup**
Run:
```bash
git add src/client/main.tsx src/client/Dashboard.tsx src/client/AdminRouting.tsx src/shared/types.ts src/client/ImageCreator.tsx
git commit -m "chore: remove client image creator and admin image UI"
```

### Task 3: Docs/env/storage cleanup
**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/public-image-creator.md`

- [ ] **Step 1: Remove image docs sections**
Strip public image and image-proxy usage sections from `README.md`.

- [ ] **Step 2: Update env example**
Remove `IMAGE_PROXY_API_KEY`, `PUBLIC_IMAGE_DIR`, `PUBLIC_IMAGE_TTL_HOURS`, queue limits from `.env.example`.

- [ ] **Step 3: Archive public image docs**
Move `docs/public-image-creator.md` to `docs/archive-public-image-creator.md`.

- [ ] **Step 4: Commit docs/env cleanup**
Run:
```bash
git add README.md .env.example docs/public-image-creator.md
git commit -m "docs: remove image creation and proxy documentation"
```

### Task 4: Remove image prompt helper
**Files:**
- Remove: `src/server/services/publicImage.test.ts`
- Modify: Any imports using `enhanceImagePrompt` if any

- [ ] **Step 1: Remove isolated public image enhancement tests**
Run:
```bash
rm src/server/services/publicImage.test.ts
```

- [ ] **Step 2: Commit prompt helper cleanup**
Run:
```bash
git add -A
git commit -m "chore: remove publicImage helper tests"
```

### Task 5: Final verification and deployment guidance
**Files:**
- README.md

- [ ] **Step 1: Run test suite with linter**
Run:
```bash
npm test
npm run lint
```

- [ ] **Step 2: Verify removed endpoints are 404**
Run:
```bash
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/image-proxy/config
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/images/usage
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/public/images/jobs
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/v1/images/generations
```

- [ ] **Step 3: Update README with deployment impact**
Add note:
```
## Deployment note
After this change, public image creator and image proxy endpoints are removed.
```

- [ ] **Step 4: Commit final verification**
Run:
```bash
git add README.md
git commit -m "docs: add deployment note for image removal"
```
