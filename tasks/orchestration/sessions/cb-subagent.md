# CB subagent

## Report 1
C1 ✅ 61f56ba — data layer: 6 migrations (metric_summary, analytics_query_results, analytics_sync_state, goals.type v2 + guardrail rank, experiments.analytics_settings, projects.reporting_currency), real TestaAnalyticsClient + MockTestaAnalyticsClient (TESTA_ANALYTICS_MOCK), DTOs, MetricSummaryRepository (F1 goldens reproduced) — gates: tests 744 run, failing set identical to master baseline (68 stock env, 0 new; 39 new analytics tests pass), phpstan 0 new vs baseline, npm build green. Branch feat/analytics-v2-cb unpushed; CA/CC can merge 61f56ba.

## Report 2
C9 ✅ e5b4d50 — sync: subscription service + hooks (PUT start/goal/stop, DELETE archive, hash skip), SyncMetricSummaryJob (unique, all §7a statuses, release ≤ $tries=3, full-range stats), FetchAnalyticsQueryJob + AnalyticsQueryDispatcher (extras, custom-range stats, 1 h, sync button refresh), webhook (HMAC timestamp.body, 5 min) before generic route, sync/status endpoints, cron v2 branch, `php artisan analytics:sync {id} [--subscribe] [--wait=N]` for the live harness; refreshed demo visitor_type fixture — gates: tests 782 run, 61 failing = master genuine set with CRO_AUDIT_* recipe (0 new; 77 analytics tests pass), phpstan 0 new, npm build green. Touched shared files: routes/api.php, app/Http/Kernel.php, config/app.php (provider), app/Console/Commands/CacheExperimentStatistics.php (v2 branch). C9 `commits:` field still empty in its task file (fill e5b4d50 on merge). Moving to CC (C2 → C3).

## Report 3
C9 follow-up ✅ 4192f65 (feat/analytics-v2-cb) — contract alignment with shared-types sync.ts/report.ts: QueryRequest now sends required `project_id`; StatsMetricInput `direction: lower` + StatsRequest `segment`; cached POST …/queries (200 + body) used without extra GET; listener for CA's AnalyticsSubscriptionDirty (by class name; tests/Feature/Domain/Analytics/Stubs/AnalyticsSubscriptionDirty.php is a stand-in — delete at C-INT once CA's class is merged) — gates: 786 tests, 61 failing = master genuine set (0 new), phpstan 0 new.

## Report 4
C2 ✅ 85d558f (feat/analytics-v2-cc) — MetricCatalogue, GoalMetricMapper, MetricDeriver (all F1 dashboard goldens), PlanningService (unpooled → 30,084; SRM 0.8277/0.6611), StatusLabeler (no double flip; platform flips `direction: lower`), DerivedStatsRequestBuilder replaces the interim C9 builder (stats keys = crobot metric ids) — gates: 825 tests, 61 failing = master genuine set (0 new), phpstan 0 new, npm build green. Request R2 logged (upsell units missing from daily rows; units_sold approximates with upsell.count, `// TODO R2`).

## Report 5
C3 ✅ 4c6075e (feat/analytics-v2-cc) — ExperimentAnalyticsController + AnalyticsViewService + normalizers (goal-table, all-metrics, trend, breakdown; others 501), MySQL-only reads, extras/custom-range stats queued → `pending` + query id; routes consolidated in CA's version-guarded block (CA's stub was shadowing CB's /sync + /extras status → now AnalyticsSyncController; stub deleted; CA's PlatformVersionTest stub-era 501 expectation updated to the real per-route statuses 200/501/404/202); SyncQuality.unconvertible_orders; R2 units_upsell (fixtures refreshed from feat/prd006-p4-fix2, TODO R2 removed) — gates: 905 tests, 61 failing = master genuine set (0 new), phpstan 0 new, npm build green.

## Report 6
CB-fix1 ✅ 680384b (feat/analytics-v2-cb-fix1, from 36b003c) — PlatformIdMap: outbound URLs + stats use experiment/variation identifiers; inbound rows, query payloads (rows + §6.5 by-variation maps), stats and webhooks map back to crobot PKs per experiment; 6 new PK≠identifier tests (RED before, GREEN after) — gates: 911 tests, 61 failing = master genuine set (0 new), phpstan 0 new, npm build green.

## Report 7
CB-fix2 ✅ (feat/analytics-v2-cb-fix2, from ffd713c; SHA in final message) — R3 project scoping: ?project_id on DELETE subscription / GET daily-summary / GET query; webhooks require project_id (400 invalid_body) and route by (project_id, identifier); 4xx platform errors mark the sync failed; 4 new two-project tests RED→GREEN — gates: 915 tests, 61 failing = master genuine set (0 new), phpstan 0 new, npm build green.

## Report 8
CB-fix3 ✅ 4589088 (feat/analytics-v2-cb-fix3, from 9d5100d) — explicit synchronous AnalyticsSubscriptionService::subscribe() (refuses v1 with version_mismatch); job + analytics:sync --subscribe use it; pull-rows "queued" was not a crobot bug (crobot stores the platform status verbatim; live run on Redis DB 13 → ready) — gates: 919 tests, 61 failing = master genuine set (0 new), phpstan 0 new, build green; live --only sync: 17 pass · 0 fail · 1 pending (CD, sync.extras 501).
