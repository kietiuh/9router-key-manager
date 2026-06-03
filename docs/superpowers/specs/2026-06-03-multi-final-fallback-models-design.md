# Multi Final Fallback Models Design

## Goal

Allow final fallback to hold an ordered list of models. Each proxied request starts with the first configured final fallback model after all normal rewrite/pass-through attempts fail; there is no round-robin, sticky state, or cross-request memory.

## Behavior

When final fallback is enabled and the request body is JSON with a `model`, the proxy builds attempts in this order:

```text
rewrite targets or source model -> final fallback model A -> final fallback model B -> ...
```

Final fallback models are deduplicated against earlier attempts and against each other. For final fallback attempts, any upstream HTTP status `>=400`, local rate queue rejection, timeout, or proxy error continues to the next final fallback model if one exists. If the last final fallback model also fails, the existing masked response is preserved: `429 server_overloaded`, `Server busy, retry later`, with `retry-after: 10`.

Requests to `/v1/audio/speech` keep `disableModelFallback` behavior and do not use final fallback.

## Compatibility

The public config shape gains `models: string[]` while keeping `model: string` as the first model and legacy compatibility field. Existing saved `final_fallback_model` values are converted into a one-item `models` list when `final_fallback_models_json` is absent. Saves write both `final_fallback_models_json` and `final_fallback_model`.

## UI

The Routing tab final fallback panel changes from one text input to an ordered list with add/remove/reorder controls. It validates that at least one non-empty model exists when enabled.

## Tests

Add regression coverage for normalization, DB compatibility, ordered retry attempts, final fallback HTTP `400` retry to the next fallback, local rate queue rejection, and request reset behavior where a second request starts from fallback A again.
