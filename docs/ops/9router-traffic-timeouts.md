# 9router Traffic Timeout Policy

This runbook keeps GoCinema GPT-5.5 request timeouts separate from traffic queue limits.

## Why This Exists

LLM requests cannot resume after a proxy timeout. If key-manager aborts an upstream `/v1/responses` attempt at 120 seconds and then falls back to another model, the replacement attempt starts from the beginning. A request that would have completed at 130 seconds can become a 120-second wait plus a second full generation.

The key-manager timeout should be a hard safety deadline for a stuck upstream, not an aggressive performance retry trigger.

## Runtime Settings

Recommended production values:

```ini
TRAFFIC_MODEL_LIMITS=cx/gpt-5.5:3:30:120000,v1/cx/gpt-5.5:3:30:120000,*:20:100:120000
TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
TRAFFIC_QUEUE_TIMEOUT_MS=120000
TRAFFIC_LARGE_CONTEXT_QUEUE_TIMEOUT_MS=120000
```

`TRAFFIC_MODEL_LIMITS` controls concurrency and queue size. Its fourth field remains as the backward-compatible base timeout when `TRAFFIC_UPSTREAM_TIMEOUTS` is not set.

`TRAFFIC_UPSTREAM_TIMEOUTS` controls active upstream generation deadlines:

```text
model:normalTimeoutMs:largeContextTimeoutMs
```

`TRAFFIC_QUEUE_TIMEOUT_MS` controls how long a request may wait for limiter slots before returning `429 queue_full`.

## Production Rollout

Create or update a systemd drop-in instead of editing secrets in the main unit:

```bash
mkdir -p /etc/systemd/system/9router-key-manager.service.d
cat >/etc/systemd/system/9router-key-manager.service.d/traffic-timeouts.conf <<'EOF'
[Service]
Environment=TRAFFIC_MODEL_LIMITS=cx/gpt-5.5:3:30:120000,v1/cx/gpt-5.5:3:30:120000,*:20:100:120000
Environment=TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
Environment=TRAFFIC_QUEUE_TIMEOUT_MS=120000
Environment=TRAFFIC_LARGE_CONTEXT_QUEUE_TIMEOUT_MS=120000
EOF
systemctl daemon-reload
systemctl restart 9router-key-manager.service
```

The drop-in is loaded after `/etc/systemd/system/9router-key-manager.service`, so these values override duplicate `Environment=` keys from the base unit.

## Verification

Confirm the merged environment:

```bash
systemctl show 9router-key-manager.service -p Environment --no-pager
```

Confirm the service and health endpoint:

```bash
systemctl show 9router-key-manager.service --property=ActiveState,SubState,NRestarts,ExecMainStatus,Result,MainPID --no-pager
curl -sS http://127.0.0.1:3000/api/health
```

Check recent timeout and proxy logs:

```bash
journalctl -u 9router-key-manager.service --since '10 minutes ago' -g 'upstream_timeout|traffic proxied request failed|queue_rejected' --no-pager -o short-iso
```

Healthy logs include `upstreamTimeoutMs` on successful proxied requests. Timeout retry logs include `timeoutMs`, `bodyBytes`, `estimatedInputTokens`, and `isLargeContext`, which makes it clear whether the normal or large-context deadline was used.

## Rollback

Remove only the timeout drop-in and restart:

```bash
rm /etc/systemd/system/9router-key-manager.service.d/traffic-timeouts.conf
systemctl daemon-reload
systemctl restart 9router-key-manager.service
```

The service then falls back to the base unit settings and built-in defaults.
