# Cross-repo live e2e report (X0)

- Run: 2026-10-16T07:23:32.405Z → 2026-10-16T07:27:10.999Z (strict)
- testa-platform: `/Users/mantasbagdonas/projects/testa-platform/.worktrees/int` @ `9214169 docs(prd006): V10 perf rerun — stats p95 308–340 ms vs 300 ms bound`
- crobot: `/Users/mantasbagdonas/projects/crobot/.worktrees/x0` @ `e2f752c test(e2e): e2e app publishes AdminLTE assets on up`
- **55 pass · 0 fail · 0 pending** 

## infra

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `infra.clickhouse` ClickHouse database prd006_x0 exists and is migrated | **pass** | X0 | X0 infra | 23 migrations applied in prd006_x0 | 16 |
| `infra.redis` Redis tp-redis DB index reachable | **pass** | X0 | X0 infra | db 13 PONG | 71 |
| `infra.collector` Collector API on :8091 healthy (Redis + ClickHouse) | **pass** | X0 | X0 infra | {"ok":true,"service":"collector","environment":"development","version":"0.0.0","checks":{"redis":true,"clickhouse":true}} | 9 |
| `infra.consumer` Collector consumer process running | **pass** | X0 | X0 infra | pid 29556 | 0 |
| `infra.modeler` Modeler process running (scheduler + workers) | **pass** | P4 | PRD-006 §3.2, V16 | pid 29618 | 0 |
| `infra.edge` Edge worker (wrangler dev) on :8792 | **pass** | X0 | X0 infra | GET /health 200 | 0 |
| `infra.crobot-web` crobot e2e app serves /login on :8188 | **pass** | X0 | X0 infra | login form served | 105 |
| `infra.crobot-db` crobot app uses crobot_e2e, migrated + seeded (project 42, experiments 1717/1802/1903/1900) | **pass** | X0 | X0 infra | crobot_e2e seeded | 487 |
| `infra.crobot-worker` crobot e2e queue worker running | **pass** | X0 | X0 infra | crb-e2e-worker | 32 |
| `infra.crobot-env` crobot e2e env: live mode, collector :8091, service token + webhook secret wired | **pass** | CB | crobot §9 live stack, X1 | services.testa_analytics wired to the live collector | 0 |

## smoke

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `smoke.ingest-roundtrip` HMAC POST /_ingest → Redis → consumer → ClickHouse prd006_x0 (read back) | **pass** | X0 | X0 smoke, PRD-001 pipeline | event 43229aea-6173-5072-8bbc-908e29370ff7 read back from prd006_x0.events | 30367 |
| `smoke.edge-roundtrip` Pixel-shaped POST /track on wrangler dev → DO batch → collector → ClickHouse | **pass** | X0 | X0 smoke, PRD-006 §1.9 edge | edge-enriched row landed (device_type=desktop) | 32447 |
| `smoke.crobot-reaches-collector` crobot container → host.docker.internal:8091 (TESTA_COLLECTOR_API_URL) reachable | **pass** | X0 | X0 smoke, crobot §9 live stack | {"ok":true,"service":"collector"} | 94 |
| `smoke.config-publish` crobot's real config publish (GenerateProjectScriptHandler) → POST /api/v1/config/{uuid} on :8091 | **pass** | X0 | X0 smoke, decision_config_api_single_source | config for project 42 stored under e2e00000-0000-4000-8000-000000000042 | 574 |

## contract

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `contract.f1-ingest` F1 (29 events) ingested via HMAC /_ingest and flushed to events | **pass** | P2 | V1, V2, X1 | 29 F1 rows in prd006_x0.events (1 batch) | 31367 |
| `contract.f3-ingest` F3 (14,229 exposures + 361 purchases, experiment 1903) ingested and flushed | **pass** | P2 | V7, V15, crobot §9 F3 label | 14590 F3 rows flushed (30 batches of ≤500) | 30831 |
| `contract.v1-row-shape` V1: stored events carry exp_* / purchase_type / parent_order_id / entry_* / channel / os_name / browser_name as sent; event_items per item | **pass** | P0+P2 | V1 | 29 F1 rows match the wire payload | 15 |
| `contract.auth` V8: sync API rejects a missing / wrong X-Service-Token with 401 | **pass** | P0 | V8, PRD-006 §5.5 | 401 on both | 12 |
| `contract.config-platform-version` crobot config publish carries experiments[].platform_version (1717 v2, 1900 v1) and the platform keeps it | **pass** | CA+P0 | crobot §3a, PRD-006 §6.1 v1/v2, CROBOT-REQUESTS R1 | platform_version flows crobot → config API | 1 |
| `contract.subscribe-f1` PUT subscription 1717 (all F1 golden keys) → 200 {status, next_run_at} | **pass** | P4 | PRD-006 §3.1, V16 | 200 {"status":"not_ready","next_run_at":"2026-10-16T07:26:24.652Z"} | 34 |
| `contract.daily-summary-golden` V2: GET daily-summary 1717 → ready; rows == f1/modeled/daily_summary.json; quality exact | **pass** | P4 | V2, V5, V17 (F1 USD→EUR), PRD-006 §3.4 | 92 rows equal the golden (run r_01M51SMTA8MZQ6SDH3TPQCA2ZZ) | 2242 |
| `contract.f1-derived` V2 + V12: summed rows reproduce the F1 per-variation and V2-dashboard tables | **pass** | P4 | V2, V12, crobot §9 numbers (platform side) | F1 tables reproduced from the live rows | 0 |
| `contract.daily-purchase-rows` V3: daily `purchase` rows exact (v3's D3 purchase credited to D1) | **pass** | P4 | V3 | 4 daily purchase rows exact | 1 |
| `contract.since-run-id` V8: ?since_run_id=<current> → 200 unchanged: true, no rows | **pass** | P4 | V8, PRD-006 §3.4 | unchanged | 6 |
| `contract.1802-lifecycle` V16 + F1 1802: subscribe → not_ready/queued/running → ready; variation 200 = 1 / 1 / €60, no 201 rows | **pass** | P4 | V16, V2 (exp in `exp` only) | statuses: not_ready → ready | 2065 |
| `contract.errors-400` V8: 400 unknown_metric / invalid_range / invalid_currency / invalid_status / unknown_view / unknown_dimension | **pass** | P4 | V8, PRD-006 §5.5 | all six 400 codes | 13 |
| `contract.errors-404` V8: 404 experiment_not_found / not_subscribed / query_not_found | **pass** | P4 | V8, PRD-006 §5.5 | three 404 codes | 12 |
| `contract.version-409` V8 + crobot §3a: v1 experiment 1900 → 409 version_mismatch | **pass** | P4 | V8, crobot §3a guards | 409 | 6 |
| `contract.tenant-isolation` R3: project 43 reuses identifier 1717 with its own data → subscriptions, rows and DELETE stay per project; project_id required | **pass** | P4 | CROBOT-REQUESTS R3, PRD-006 §3.1 / §3.4 | 1717 isolated: project 42 run r_01M51SMTA8MZQ6SDH3TPQCA2ZZ, project 43 run r_01M51SNWSEW4RR778VBK5VY4A0 | 33562 |
| `contract.query-payment-type` V12: summary query dimension=payment_type (add_payment_info + purchase): card 1/1 vs paypal 1/1, post_exposure | **pass** | P4 | V12, PRD-006 §6.3, crobot §6 Funnel | payment_type split exact | 2036 |
| `contract.query-dedup` V16: same query body → same query_id; cached result returns 200 ready | **pass** | P4 | V16, PRD-006 §3.5 | dedup + 1 h cache | 21 |
| `contract.query-products` V13: products view = F1 products table (SKU-A units share 1.0 vs 0.5) | **pass** | P7 | V13, crobot §9 SKU-A units share | F1 products exact | 2028 |
| `contract.query-distributions` V13: distributions view = F1 (payment_type, coupon, currency) | **pass** | P7 | V13, crobot §6 Revenue | F1 distributions exact | 2022 |
| `contract.query-health` V14: health view — purchase ok (variant 3 events), add_to_cart warning (price 0.5), payment_type 1.0 | **pass** | P8 | V14, crobot §9 health warning | F1 health expectations | 2040 |
| `contract.stats-f3` V7: POST /api/v1/stats with F3 sums — 101 beat ∈ [0.902, 0.912], best ∈ [0.871, 0.881]; deterministic; insufficient_data; control flip | **pass** | P3 | V7, PRD-006 §4.4 golden, crobot §9 F3 (platform side) | 101 beat=0.90566 best=0.87477 | 99 |

## sync

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `sync.subscribe` crobot subscribes 1717 → platform metric_subscriptions has crobot's core keys + goal:12, EUR, from 2026-10-01 | **pass** | CB | crobot §7a subscription, PRD-006 §3.1, X1 | via App\Domain\Analytics\Services\AnalyticsSubscriptionService::subscribe; 20 keys | 547 |
| `sync.webhook-push` platform run → signed summary-ready webhook → crobot worker syncs metric_summary (no manual trigger) | **pass** | P4+CB | PRD-006 §3.2 webhook, crobot §7a webhook, V16 webhook | 80 rows synced by the worker for run r_01M51SP7SXQ9PACZ5J1W8E8QSJ | 2613 |
| `sync.pull-rows` SyncMetricSummaryJob (dispatchSync) → crobot metric_summary == platform daily-summary rows; sync state ready + run_id | **pass** | CB | crobot §7a ready row, crobot §9 live, X1 | 80 rows identical to run r_01M51SP7SXQ9PACZ5J1W8E8QSJ (NOTE: crobot stores its own variations.id, mapped back) | 978 |
| `sync.f1-values` crobot metric_summary sums → F1 CR 33.33/66.67 %, AOV 100/62.50, RPV 33.33/48.33, upsell 0/50 %, cart abandonment 0/100 %, payment→purchase 100/200 % | **pass** | CB | crobot §9 (data), X1 | matches crobot §9: {"100":{"visitors":"3","conversions":"1","cr":"33.33%"},"101":{"visitors":"3","conversions":"2","cr":"66.67%"}} | 1 |
| `sync.stats-row` after a new run crobot stores full-range stats (POST /api/v1/stats) as an analytics_query_results `stats` row | **pass** | CB+P3 | crobot §7a ready row, PRD-006 §4.5 | stats cached in MySQL | 435 |
| `sync.idempotent` second sync with no new run: rows unchanged, no duplicates (since_run_id path) | **pass** | CB | crobot §7a unchanged, PRD-006 §3.4 since_run_id | replay is a no-op | 1335 |
| `sync.webhook-auth` crobot webhook: valid HMAC → 2xx; bad signature and stale (>5 min) timestamp → rejected | **pass** | CB | crobot §4 VerifyAnalyticsWebhook, PRD-006 §3.2 | HMAC over timestamp.body enforced | 133 |
| `sync.extras` crobot extras via its API (health, products, revenue, funnel) → FetchAnalyticsQueryJob → live queries → MySQL results | **pass** | CC+CB | crobot §7a extras, crobot §6 screens, X1 | extras fetched live and cached | 4517 |
| `sync.f3-label` F3 experiment 1903: crobot subscribe + sync + stats → purchase goal Inconclusive at 95 % (91 %) | **pass** | CB+CC+P3 | crobot §9 F3 label, V7, X1 | F3: beat=0.90566, label Inconclusive | 3435 |
| `sync.v1-guard` crobot refuses to subscribe the v1 experiment 1900 (client refuses v1 ids) | **pass** | CA+CB | crobot §3a guards | App\Domain\Analytics\Clients\Exceptions\AnalyticsVersionMismatchException: Experiment 5004 is not a v2 experiment; the analytics client refuses it | 434 |

## ui

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `ui.login` Playwright: seeded user logs into the e2e app on :8188 | **pass** | X0 | X0 smoke, crobot §9 live | [ui.login] seeded user logs into the e2e app | 13659 |
| `ui.f1-purchase` UI: purchase goal 3 / 1 / 33.33 % vs 3 / 2 / 66.67 % | **pass** | CD | crobot §9 purchase, X1 | [ui.f1-purchase] purchase goal: 3 / 1 / 33.33% vs 3 / 2 / 66.67% | 0 |
| `ui.f1-aov-rpv` UI: AOV €100.00 vs €62.50; RPV €33.33 vs €48.33 | **pass** | CD | crobot §9 AOV/RPV, X1 | [ui.f1-aov-rpv] AOV €100.00 vs €62.50; RPV €33.33 vs €48.33 | 0 |
| `ui.f1-upsell` UI: upsell rate 0 % vs 50 % | **pass** | CD | crobot §9 upsell, X1 | [ui.f1-upsell] upsell rate 0% vs 50% | 0 |
| `ui.f1-funnel` UI: cart abandonment 0 % vs 100 %; payment → purchase 100 % vs 200 % | **pass** | CD | crobot §9 funnel, X1 | [ui.f1-funnel] cart abandonment 0% vs 100%; payment → purchase 100% vs 200% | 0 |
| `ui.f1-products` UI: SKU-A units share 100 % vs 50 % | **pass** | CD | crobot §9 products, X1 | [ui.f1-products] SKU-A units share 100% vs 50% | 0 |
| `ui.f1-health` UI: Data health shows the add_to_cart warning | **pass** | CD | crobot §9 health, X1 | [ui.f1-health] Data health shows the add_to_cart warning | 0 |
| `ui.f3-label` UI: F3 purchase goal Inconclusive at 95 % | **pass** | CD | crobot §9 F3 label, X1 | [ui.f3-label] F3 purchase goal labelled Inconclusive at 95% | 0 |

## lifecycle

| Check | Status | Owner | DoD | Detail | ms |
|---|---|---|---|---|---|
| `lifecycle.stopped-final` V3: stopped subscription to = D2 → final run: variant purchasers 1, revenue €65.00, visitors 3 / 3 | **pass** | P4 | V3, PRD-006 §3.1 stopped | final run r_01M51SQ2JCBN1P9G83WZ314H6Z | 2078 |
| `lifecycle.unsubscribe` DELETE subscription 1802 → daily-summary 404 not_subscribed | **pass** | P4 | PRD-006 §3.1 DELETE, crobot §7a archive | unsubscribed | 22 |
