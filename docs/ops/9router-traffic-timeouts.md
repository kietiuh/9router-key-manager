# 9router Traffic RPM And Timeout Policy

This runbook separates three controls on `/v1/*` traffic:

- API-key client rate limiting controls how much one API key can send to key-manager.
- Model RPM limiting controls when key-manager starts requests to 9router.
- Upstream timeouts control how long an active upstream attempt may run before key-manager aborts it.

## API-Key Client Rate Limiting

Client rate limiting is configured in the admin UI under `Giám sát 9router`.

The default config is enabled:

```json
{
  "enabled": true,
  "rpm": 30,
  "concurrency": 5
}
```

The limiter is keyed by the resolved 9router API key id, not by IP. If a bearer token is present but does not match a known key, key-manager uses a short hash fingerprint of that token so invalid-key spam is still bounded without logging the secret. It runs after key expiry/quota checks and before image direct proxy or chat/text proxy attempts. This keeps admin APIs, public key checks, watcher jobs, and bot delivery outside the limiter while protecting the `/v1/*` hot path.

When a key exceeds RPM or concurrency, key-manager returns `429` with `retry-after`. RPM rejections also include `x-ratelimit-reset`.

## Model RPM Limiting

RPM limiting is configured in the admin UI under `Giám sát 9router`.

Each rule targets the final model sent to 9router. If a client calls one model and model rewrite changes it to `v4/gpt-5.5`, the `v4/gpt-5.5` rule applies. If a failover attempt later targets another model, that attempt uses the other model's rule.

Example:

```json
{
  "enabled": true,
  "rules": [
    {
      "model": "v4/gpt-5.5",
      "enabled": true,
      "rpm": 12,
      "queueLimit": 100,
      "maxQueueWaitMs": 300000
    }
  ]
}
```

With `12rpm`, matching requests are released evenly about once every 5 seconds. Models without a matching enabled rule pass through immediately.

The queue is bounded by `queueLimit` and `maxQueueWaitMs`. When a matching request cannot reserve a slot, key-manager returns `429` with `retry-after`.

## Upstream Generation Deadlines

LLM requests cannot resume after a proxy timeout. If key-manager aborts an upstream `/v1/responses` attempt at 120 seconds and then falls back to another model, the replacement attempt starts from the beginning. The timeout should be a hard safety deadline for stuck upstream attempts, not an aggressive performance retry trigger.

Recommended production values:

```ini
TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
TRAFFIC_LARGE_CONTEXT_TOKENS=100000
```

`TRAFFIC_UPSTREAM_TIMEOUTS` format:

```text
model:normalTimeoutMs:largeContextTimeoutMs
```

`TRAFFIC_MODEL_LIMITS` is no longer a concurrency limiter. Its fourth field is only read as a backward-compatible legacy timeout fallback when `TRAFFIC_UPSTREAM_TIMEOUTS` does not provide a match.

## Production Rollout

Timeout values still belong in a systemd drop-in:

```bash
mkdir -p /etc/systemd/system/9router-key-manager.service.d
cat >/etc/systemd/system/9router-key-manager.service.d/traffic-timeouts.conf <<'EOF'
[Service]
Environment=TRAFFIC_UPSTREAM_TIMEOUTS=cx/gpt-5.5:300000:600000,v1/cx/gpt-5.5:300000:600000,*:120000:180000
Environment=TRAFFIC_LARGE_CONTEXT_TOKENS=100000
EOF
systemctl daemon-reload
systemctl restart 9router-key-manager.service
```

API-key client limits and model RPM rules do not require a restart. Save them from the admin traffic tab.

## Verification

Confirm the service and health endpoint:

```bash
systemctl show 9router-key-manager.service --property=ActiveState,SubState,NRestarts,ExecMainStatus,Result,MainPID --no-pager
curl -sS http://127.0.0.1:3000/api/health
```

Check recent timeout, client limiter, RPM queue, and proxy logs:

```bash
journalctl -u 9router-key-manager.service --since '10 minutes ago' -g 'upstream_timeout|client rate limited request rejected|model rate limited request rejected|traffic proxied request failed' --no-pager -o short-iso
```

Healthy proxied request logs include `clientRateLimitRpm`, `clientConcurrencyLimit`, `clientRateRemaining`, `clientActive`, `rateQueuedMs`, `rateLimitModel`, `rateLimitRpm`, `rateLimited`, and `upstreamTimeoutMs`. `rateQueuedMs > 0` means the request waited for a model RPM slot before going to 9router.

## Rollback

To disable API-key client rate limiting, turn off `Bật giới hạn theo API key` in the admin traffic tab and save.

To disable RPM limiting, turn off `Bật giới hạn RPM` in the admin traffic tab and save.

To remove only the timeout drop-in:

```bash
rm /etc/systemd/system/9router-key-manager.service.d/traffic-timeouts.conf
systemctl daemon-reload
systemctl restart 9router-key-manager.service
```
