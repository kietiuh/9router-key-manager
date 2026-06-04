# API-Key Client Rate Limit Design

## Goal

Protect `/v1/*` traffic from one API key repeatedly spamming key-manager and upstream model calls. The default policy is enabled at `30` requests per minute and `5` concurrent requests per API key, with admin UI controls for runtime changes.

## Existing Context

The repo already has token quota interception, key expiry interception, model rewrite/fallback, image direct proxy, and a model RPM limiter. The existing model RPM limiter is keyed by final model name after rewrite/fallback, so it does not prevent one API key from opening many concurrent requests or exhausting its own request budget.

## Design

Add a separate `ClientRateLimiter` keyed by resolved API key id. If a bearer token does not resolve to a known key, use a short hash fingerprint of that token so invalid-key spam is still bounded without logging the secret. Missing bearer tokens keep the existing behavior and pass through to upstream handling.

The limiter runs in the `/v1/*` hot path after key expiry and quota checks, before image direct proxy and before `fetchUpstreamWithFailover()`.

The limiter uses an in-memory rolling 60-second timestamp window for RPM and an active lease counter for concurrency. Accepted requests receive a lease. Buffered image proxy requests release in `finally`; streaming model requests release on stream `close`, `error`, or `end`; failed requests release in `finally`.

## Error Handling

RPM and concurrency rejections return HTTP `429` with an OpenAI-compatible error body:

```json
{
  "error": {
    "message": "API key RPM limit exceeded",
    "type": "rate_limit_exceeded",
    "code": "client_rpm_exceeded",
    "retry_after": 60,
    "reset_at": "2026-06-04T00:01:00.000Z"
  }
}
```

Concurrency rejections use code `client_concurrency_exceeded` and `retry-after: 1`.

## Configuration

Config is stored under `app_settings.key = 'client_rate_limit_config'` in `manager.sqlite`. Defaults are `{ "enabled": true, "rpm": 30, "concurrency": 5 }`. Admins can change it in the traffic tab without restarting the service.

## Non-Goals

This design does not replace token quota, model RPM queues, model rewrite/fallback, upstream timeout policy, or IP-based perimeter protection. It also does not introduce Redis or cross-instance shared state; the current deployment is a single key-manager instance.
