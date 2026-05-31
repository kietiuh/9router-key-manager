# 9router Synthetic Usage Patch

This runbook covers the temporary GoCinema patch for installed 9router builds that return zero or partial token usage for `v4` and `cl` provider nodes, and for streaming request detail rows that stay at `0/0`.

## Behavior

The patch updates the installed 9router server bundle so that successful usage writes for provider nodes whose `providerNodes.data.prefix` is `v4` or `cl` get fallback token values:

- if input tokens are `0`, record random `50,000-100,000` input tokens
- if output tokens are `0`, record random `100-5,000` output tokens
- preserve any side that already has nonzero usage

The patch writes into 9router `usageHistory`, so `9router-key-manager` usage ingestion sees the same values. The old key-manager-only synthetic v4 fallback should remain disabled to avoid double counting.

The patch also ties streaming `requestDetails` start and completion writes to the same row id, and applies the same fallback token values before the completion row is written. Without this, 9router writes one `0/0` row when the stream starts and a separate completion row can still carry `0/0`; the dashboard Recent Requests can then be crowded by zero-token rows and appear to miss successful v4 requests.

## Apply

Dry-run first:

```bash
cd /root/.openclaw/workspace/code/github/9router-key-manager
npm run ops:patch-9router-synthetic-usage
```

Apply to the installed 9router bundle:

```bash
npm run ops:patch-9router-synthetic-usage -- --apply
systemctl restart 9router.service
```

The script reads provider node ids from `/root/.9router/db/data.sqlite` by default and creates a bundle backup beside the patched file.

## Verify

After sending a `v4` or `cl` request, check that 9router has nonzero usage rows:

```bash
./node_modules/.bin/tsx -e "import Database from 'better-sqlite3'; const db=new Database('/root/.9router/db/data.sqlite',{readonly:true}); console.log(db.prepare(\"select provider, model, promptTokens, completionTokens, tokens, timestamp from usageHistory order by id desc limit 10\").all())"
```

Then confirm key-manager ingests from `usageHistory` and no `key-manager-synthetic` rows are being added for new v4 requests.

Also confirm the newest matching `requestDetails` rows have nonzero `tokens` in `data` after the stream completes:

```bash
./node_modules/.bin/tsx -e "import Database from 'better-sqlite3'; const db=new Database('/root/.9router/db/data.sqlite',{readonly:true}); console.log(db.prepare(\"select timestamp, provider, model, data from requestDetails where provider like '%95d5d599%' order by timestamp desc limit 5\").all().map(r=>({timestamp:r.timestamp, provider:r.provider, model:r.model, tokens: JSON.parse(r.data).tokens})))"
```

## Rollback

Restore the backup created by the apply command:

```bash
cp /usr/lib/node_modules/9router/app/.next-cli-build/server/chunks/6379.js.synthetic-usage.<timestamp>.bak /usr/lib/node_modules/9router/app/.next-cli-build/server/chunks/6379.js
systemctl restart 9router.service
```

Reapply this patch after reinstalling or upgrading 9router, because package updates replace the compiled server bundle.
