# Reference — HTTP endpoints

All HTTP surfaces of the platform, in one place.

## Edge worker (`apps/edge`)

Base URL: `https://testa-edge.workers.dev` (or customer's CNAME `track.{customer}.com`).

### `GET /projects/:slug.js`

Serves the pixel for a project.

```http
GET /projects/abc123.js HTTP/1.1
Host: track.example.com

200 OK
Content-Type: application/javascript; charset=utf-8
Cache-Control: public, max-age=60, stale-while-revalidate=300
Set-Cookie: _testa_uuid=v_xyz123; Domain=.example.com; Max-Age=63072000;
            Path=/; SameSite=Lax; Secure
ETag: "<config_hash>"

(function(){ /* loader */ })();
(function(){ /* runtime + window.cfPrefill */ })();
```

If `If-None-Match` matches the current `config_hash`, return 304.

If project doesn't exist or `integration_version` is null, return 404.

### `POST /track`

Accepts events from the pixel.

```http
POST /track HTTP/1.1
Host: track.example.com
Content-Type: application/json
Cookie: _testa_uuid=v_xyz123; _testa_ses=s_abc

[ /* PixelEvent, PixelEvent, … */ ]

204 No Content
Set-Cookie: _testa_uuid=v_xyz123; ... (refresh)
Access-Control-Allow-Origin: *
```

CORS allowed from any origin (the customer's site is the caller). Credentials not used (cookies are first-party from the customer's perspective when in CNAME mode).

The body is a bare JSON array of `PixelEvent`s. Each entry is validated with Zod (`apps/edge/src/validate.ts`, P2 `544a5d6`): an invalid entry is **dropped** and the rest of the batch continues; the response is always 204. The worker normalizes `checkout_start` → `begin_checkout`, truncates `items` to 50 (`props._items_truncated = 1`), derives `items_count`, and enriches OS / browser families, `referrer_domain` and `channel` (see `event-shape.md`). Requests without `Accept-Language` or with a headless UA are tagged `is_bot = 1` (forwarded, excluded from analytics).

> **Cross-origin caveat.** The pixel posts with `fetch` (`keepalive`) and falls back to `sendBeacon` on `pagehide`. Browsers refuse a cross-origin `sendBeacon` with a JSON body, so when `/track` is on a **different origin** than the page (e.g. `cfPrefill.apiUrl` pointing at another host or port), events still queued at unload are lost until the next page view flushes the outbox. Serve `/track` same-origin (the default) in production.

### `OPTIONS /track`

CORS preflight. Returns 204 with the standard CORS headers.

### `GET /health`

```http
GET /health HTTP/1.1

200 OK
Content-Type: application/json

{ "ok": true, "environment": "production" }
```

Used by uptime monitors. Not authenticated.

## Collector (`apps/collector`)

Base URL: `http://collector.testa.internal:8000` (internal-only; not exposed publicly).

### `POST /_ingest`

Accepts HMAC-signed batches from the edge worker.

```http
POST /_ingest HTTP/1.1
Content-Type: application/json
X-Edge-Signature: <hex-sha256-hmac>

{
  "signed_at": 1730902400123,
  "events": [ /* EnrichedEvent[] */ ]
}

204 No Content                         (success)
401 Unauthorized                       (bad signature)
400 Bad Request                        (replay window exceeded OR Zod fail)
```

See `docs/reference/hmac-protocol.md`.

### `POST /api/v1/config/:projectId` · `GET /api/v1/config/:projectId`

Config API: crobot POSTs its project JSON (`Authorization: Bearer <CONFIG_WRITE_TOKEN>`); the collector builds the servable `ProjectConfig` (incl. each experiment's `platform_version`, 'v1' | 'v2' only) and stores it under `:projectId` (crobot's project UUID). GET serves it publicly.

Configs live in the config store: `CONFIG_STORE=file` (default; `{CONFIG_DIR}/{key}.json`) or `CONFIG_STORE=redis` (`{CONFIG_REDIS_PREFIX}{key}`, default prefix `testa:config:`; shared by all processes/machines, required when the modeler runs apart from the API). Every save also writes a **numeric-id alias** (file: `{CONFIG_DIR}/_by-project-id/{project_id}.json`; redis: `{prefix}by-project-id:{project_id}` → store key), because events, subscriptions and the sync API carry the numeric `project_id`. The sync API / modeler resolve configs through it (P4-fix1 `b9681b3`); `GET /api/v1/config/{numericId}` still answers 404 unless a config was stored under that key. Configs published before the alias existed need one re-publish.

### Sync API — `/api/v1/experiments/*` (PRD-006 Part 3)

crobot subscribes an experiment; the **modeler** (separate process) refreshes it into additive daily rows (`metric_daily`); crobot pulls the stored rows. **Reads never compute.** Auth on every route: `X-Service-Token: <SERVICE_TOKEN>` (401 `{ "error": "unauthorized" }`). Experiment ids are unique **per project** only, so every experiment-scoped call carries `project_id` (R3, P4-fix3 `f572432`). Errors are `{ "error": <SyncErrorCode>, "field"?: string }`.

| Route | `project_id` | Success |
|---|---|---|
| `PUT /api/v1/experiments/:id/subscription` | body | 200 `{ status, next_run_at }` |
| `DELETE /api/v1/experiments/:id/subscription` | `?project_id=` | 200 `{ status, next_run_at: null }` |
| `GET /api/v1/experiments/:id/daily-summary[?since_run_id=]` | `?project_id=` | 200 `DailySummaryResponse` + `Retry-After` |
| `POST /api/v1/experiments/:id/queries` | body | 202 `{ query_id, status, retry_after }` · 200 `QueryResponse` when a fresh cached result exists and `refresh` is false |
| `GET /api/v1/experiments/:id/queries/:queryId` | `?project_id=` | 200 `QueryResponse` + `Retry-After` |

**Subscription body** (`SubscriptionRequest`): `{ project_id, status: 'running'|'stopped', from, to: null|date, report_currency, metrics: MetricKey[] }`. Idempotent — an identical repeat PUT changes nothing; a new subscription, a changed metric list / range / currency, or a stop enqueues a refresh at high priority. `stopped` gets one final run kept permanently (`is_final = 1`).

**Metric keys** (`MetricKey`, §2.3): `purchase`, `upsell`, `revenue`, `add_to_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `generate_lead`, `sign_up`, `page_view`, `units`, `units_upsell` (R2, P4-fix2 `b4e856d`: units bought in upsell orders; `units` stays initial orders only), `units_added`, `units_bought_from_cart`, `coupon`, `lead`, `lead_purchase`, `repeat_purchase`, `cart_purchase`, `checkout_purchase`, `session`, plus `event:<name>` and `goal:<id>`.

**Daily summary** (`DailySummaryResponse`): run envelope `{ status, run_id, computed_at, data_through, next_run_at, retry_after }` + `{ experiment_id, from, to, report_currency, date_basis: 'first_exposure', cap_outliers: false, dimension: null, quality, rows, unchanged? }`. Statuses (§3.3): `not_ready` (no run finished yet, `rows: []`), `queued` / `running` (rows of the last finished run), `ready`, `failed` (last good run still served). `since_run_id` equal to the current run → `unchanged: true`, no rows. A subscribed experiment with no exposures ends `ready` with `rows: []`. `run_id` = `r_<ULID>`.

`quality`: `{ multi_variation_visitors, variation_mismatch_events, unconvertible_orders? }` — `unconvertible_orders` (orders in a currency with no known FX rate, left out of money sums) is present only when > 0 (P2 `c5d021a`).

**Queries** (`QueryRequest`): `{ view: 'summary'|'products'|'distributions'|'health', project_id, from, to, report_currency?, filters?, refresh?, …view params }`. `query_id` = sha256 of the canonical body (keys sorted, `refresh` excluded, scoped to the experiment and — via `project_id` — the project). Results live 1 h (then 410 `expired`); unknown ids 404 `query_not_found`. `summary` responses carry `rows` (+ `dimension`, `cap_outliers`, `quality`), the other views `result` (`null` until ready).

| View | Params | Result |
|---|---|---|
| `summary` | `metrics`, `dimension?` (one of §3.6 + `payment_type`), `cap_outliers?` | daily rows, top 10 + `(other)` per dimension; `payment_type` splits only `add_payment_info` + `purchase` and marks rows `post_exposure: true` |
| `products` | `product_id?` (detail mode), `purchase_type?` all\|initial\|upsell, `search?`, `sort?` control_revenue\|revenue_share, `limit?` (default 8, ≤ 200), `offset?` | `ProductsListResult` / `ProductDetailResult` |
| `distributions` | `distributions?` (payment_type, coupon, currency, order_value), `order_value_bins?`, `cap_outliers?` | `DistributionsResult`; with `cap_outliers: true` also `capped: { threshold, by_variation }` — pooled p99 of initial-order values and how many initial orders exceeded it per variation (R4, P7-fix1 `6099edb`; absent otherwise) |
| `health` | — | `HealthResult` (events vs `EVENT_PARAM_SPEC`, metric availability, SRM, summary) |

Non-empty `filters` → 400 `unknown_dimension` (`field: "filters"`; not supported by the MVP queries).

**Errors** (`SyncErrorCode`, §5.5 + R3):

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_body` | missing / invalid `project_id` (`field: "project_id"`); also the stats endpoint's body errors |
| 400 | `unknown_metric` / `unknown_dimension` / `unknown_view` / `invalid_range` / `invalid_currency` / `invalid_status` | validation (`field` names the input); invalid JSON → `invalid_status` (PUT) / `unknown_view` (POST) with `field: "body"` |
| 401 | `unauthorized` | missing / wrong `X-Service-Token` |
| 404 | `experiment_not_found` | the experiment isn't in that project's config |
| 404 | `not_subscribed` / `query_not_found` | owned experiment, but no subscription / no such query |
| 409 | `version_mismatch` | the experiment isn't `platform_version: "v2"` (R1) |
| 410 | `expired` | query result past its 1 h TTL |
| 429 | `too_many_queries` | > 60 POSTs / min or ≥ 200 pending queries, per project |
| 501 | `not_implemented` | a view with no runner registered |
| 500 | `internal_error` | unhandled (not in `SyncErrorCode`) |

**Webhooks** (optional, `CROBOT_WEBHOOK_URL` set): POST `{CROBOT_WEBHOOK_URL}/api/webhooks/analytics/{event}` with `X-Testa-Timestamp` and `X-Testa-Signature: sha256=<hex HMAC-SHA256(CROBOT_WEBHOOK_SECRET, timestamp + "." + rawBody)>`; bodies `{ event: 'summary-ready', project_id, experiment_id, run_id, computed_at, data_through }` and `{ event: 'query-ready', project_id, experiment_id, query_id, computed_at }`. Retried (`CROBOT_WEBHOOK_RETRY_DELAYS_SEC`, default 10, 60, 300 s), then dropped.

**Modeler** (`apps/collector/src/modeler/main.ts`): long-running (`dev:modeler`) or one synchronous pass with `--once` / `MODELER_ONCE=1`. The API server and the modeler must share Redis, ClickHouse, the config store (`CONFIG_STORE=redis` when they are separate processes/machines) and `MODELER_KEY_PREFIX`. Env: `MODELER_CONCURRENCY` (4), `MODELER_INTERVAL_SEC` (900), `MODELER_MAX_RUN_AGE_SEC` (86400), `MODELER_LOCK_TTL_SEC` (600), `MODELER_MAX_EXECUTION_SEC` (300), `MODELER_RETRY_DELAYS_SEC` (30,120,300), `MODELER_QUERY_TTL_SEC` (3600), `MODELER_POLL_MS` (1000), `CROBOT_WEBHOOK_URL`, `CROBOT_WEBHOOK_SECRET` (≥ 16 chars when the URL is set), `CROBOT_WEBHOOK_RETRY_DELAYS_SEC`. Redis keys (under `{prefix}modeler:`) are project-scoped: `run:{pid}:{eid}`, `lock:{pid}:{eid}`, `query-pending:{pid}`, `query-rate:{pid}:{minute}`.

### `POST /api/v1/stats` (PRD-006 Part 4)

Stateless Bayesian Monte Carlo over summed rows (no ClickHouse, no state; P3 `db54724`). Auth: `X-Service-Token`.

```jsonc
// request (StatsRequest)
{ "control": 100, "confidence": 0.95, "draws": 100000, "segment": false,
  "metrics": [
    { "key": "cr", "model": "beta", "direction": "higher",
      "variations": [ { "variation": 100, "n": 4737, "x": 115 }, { "variation": 101, "n": 4790, "x": 137 } ] },
    { "key": "aov", "model": "normal",
      "variations": [ { "variation": 100, "n": 107, "sum": 9855.6, "sumSq": 1265432.1 },
                      { "variation": 101, "n": 120, "sum": 8839.2, "sumSq": 902211.7 } ] } ] }
// 200 (StatsResponse)
{ "metrics": { "cr": { "100": { "chance_to_be_best": 0.093 },
                       "101": { "chance_to_beat_control": 0.907, "chance_to_be_best": 0.907, "lift": 0.187,
                                "lift_ci": [-0.076, 0.504], "expected_loss": 0.0058 } } } }
```

- `confidence` ∈ (0, 1), default 0.95; `draws` 1–100,000 (default 100k, 10k with `segment: true`); each metric needs ≥ 2 variations including `control`; beta needs `x ≤ n`, normal needs `sum` + `sumSq`. `direction: 'lower'` flips chance to beat / best / loss (so "better" is always chance_to_beat_control ≥ confidence, §6.4).
- Control rows carry `chance_to_be_best` only; `insufficient_data: true` below 100 visitors or 10 conversions / orders. Identical input → identical output (seeded).
- Errors (all 400 except auth): `invalid_body` (bad JSON — no field; schema / cross-field — `field` is the path, e.g. `metrics[0].variations[1].x`), `too_large` (> 50 metrics or > 10 variations — `field`; body > 256 KiB — no field). `too_large` is local to the stats route, not in `SyncErrorCode`.

### `GET /_internal/fx-rates`

ClickHouse dictionary source. Returns daily FX rates as `JSONEachRow`.

```
{"date":"2026-05-05 00:00:00","from_ccy":"EUR","to_ccy":"USD","rate":1.082}
{"date":"2026-05-05 00:00:00","from_ccy":"GBP","to_ccy":"USD","rate":1.262}
...
```

Not authenticated (CH internal pull). Restrict via network policy.

PRD-006 money conversion does not use this dictionary: the modeler and views read `fx_rates_history` directly — previous UTC day's rate, falling back to the last known rate (`apps/collector/src/fx/sql.ts`). `syncToday` also backfills the last 400 days (weekends / holidays carry the previous business day forward), so it runs on collector start and daily (P2 `c5d021a`).

### `GET /_internal/health`

```http
200 OK
{ "ok": true, "service": "collector", "version": "0.0.0", "environment": "production" }
```

## Crobot proxy (`crobot`)

Base URL: existing crobot domain.

### Analytics V2 (PRD-006) — crobot pulls, never proxies per page

The old per-request metrics proxy (`GET /api/experiments/{id}/metrics/{metric}` → collector `/api/v1/metrics/*`) is gone with the read API it fronted (tasks 4.1–4.8 cancelled, PRD-006 §5.8). Crobot now:

- sends `PUT` / `DELETE …/subscription` from its experiment start / change / stop / archive services (v2 experiments only);
- runs a `SyncMetricSummaryJob` per running v2 experiment from the 15-min cron (and on the `summary-ready` webhook) that pulls `GET …/daily-summary?project_id=&since_run_id=` into MySQL `metric_summary`;
- posts on-demand queries from jobs and caches results 1 h;
- calls `POST /api/v1/stats` with summed rows;
- renders the UI from MySQL only.

All calls carry `X-Service-Token`. See crobot `tasks/prd-analytics-v2.md`.

### Existing legacy endpoints (unchanged)

These keep working as today; 4.0 pixel still calls them for back-compat.

- `POST /api/leads` — creates a Lead row in MySQL
- `POST /api/leads/convert` — records a goal conversion
- `GET /api/pixel` — Shopify Custom Pixel 1×1 GIF tracker
- `POST /api/marketing/create-lead` — marketing funnel email capture

See `crobot/routes/api.php` and `crobot/app/Http/Controllers/API/LeadController.php`.

## Versioning

- Edge endpoints: no version prefix; backwards-compatible only. Behavior changes are gated by per-project `integration_version`.
- Collector internal API: prefixed `/api/v1/`. Breaking changes bump the prefix.
- Sync API / stats: additive changes only within `/api/v1/` (new optional fields, new metric keys); crobot DTOs must tolerate unknown fields.
