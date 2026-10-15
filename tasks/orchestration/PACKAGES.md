# Work packages — PRD-006 (testa-platform) + Analytics V2 (crobot)

A **package** is the unit the orchestrator hands to one session: an ordered
list of tasks, the paths it may edit, its branch and worktree, and its gates.
One session works on one package at a time. A package is done when every task
in it is `done` (or `blocked` with a logged reason) and its gates are green.

## Dependency graph

```
                    ┌─ P1 pixel + SDK ─────────────┐
                    ├─ P2 ingest + FX ─────────────┤
P0 contracts ──────►├─ P3 stats ───────────────────┤
 (platform, alone)  ├─ P4 modeler + sync API ──────┼──► P6 platform integrate ──┐
                    ├─ P7 products + distributions ┤     + full validation      │
                    ├─ P8 health ──────────────────┤                            ├──► X1 cross-repo
                    └─ P5 validation harness ──────┘                            │    acceptance
CA config (C0 → C8 → C10) ───────────────────────────────┐                      │
CB data + sync (C1 → C9) ──► CC services (C2 → C3) ──► CD UI (C4–C7) ──► C-INT ─┘
```

- **Can start immediately:** P0, CA, CB (CB runs on mock fixtures).
- **After P0 is merged into `feat/prd006`:** P1, P2, P3, P4, P5, P7, P8.
- **After C1 is merged into `feat/analytics-v2`:** CC. **After C3:** CD.
- **Critical path:** P0 → P4 (5.9 → 5.15 → 5.8) → P6 → X1. Give P4 to a session first.

## Branches and worktrees

| Repo | Integration branch (orchestrator merges into it) | Package branch | Worktree |
|---|---|---|---|
| testa-platform | `feat/prd006` | `feat/prd006-<pkg>` (e.g. `feat/prd006-p4`) | `~/projects/testa-platform/.worktrees/<pkg>` |
| crobot | `feat/analytics-v2` | `feat/analytics-v2-<pkg>` (e.g. `feat/analytics-v2-cb`) | `~/projects/crobot/.worktrees/<pkg>` (inside the repo so the Docker mount sees it; crobot PRD §10a) |

Package branches start from the **current** integration branch. Nothing is
merged into `main`, pushed or deployed unless the human says so.

## Shared local resources (isolation)

| Resource | Rule |
|---|---|
| ClickHouse | one `docker compose up -d redis clickhouse` from the testa-platform main checkout; each package uses database `prd006_<pkg>` (`CLICKHOUSE_DATABASE`), creates it if missing, runs `migrate` against it. Never `default`. |
| Redis | key prefix `prd006:<pkg>:` |
| Ports | only P5 (dry-run: none) and P6 / X1 start servers; P6 owns 8090. Others use in-process tests. |
| Crobot DB | tests use SQLite in-memory; never run migrations against the dev MySQL from a package |
| Dependencies | `pnpm install` (platform) or `composer install && npm ci` (crobot, inside `crb-php`) once per worktree |

## testa-platform packages

Task files: `tasks/phase-5/5.*.md`. Rules: `tasks/phase-5/LOOP.md`.
Spec: `docs/prds/006-ecommerce-events-and-metric-modeling.md` (Parts 5–6 win).

| Pkg | Tasks (in order) | Owns (may edit) | Gates | Notes |
|---|---|---|---|---|
| **P0** contracts | 5.1 → 5.2 → 5.18 (+ stats stub) | `packages/shared-types/**`, `apps/collector/db/migrations/013–023*`, `docs/reference/clickhouse-schema.md`, `docs/reference/project-config-shape.md`, `apps/collector/src/{analytics,auth,sync,modeler}/**` (stubs), `apps/collector/src/stats/{index,router}.ts` (stubs), `apps/collector/src/{products,distributions,health}/view.ts` (stubs), `apps/collector/src/index.ts`, `apps/collector/package.json` | each task's gate + G3 | Run alone. After merge, **shared-types and `index.ts` are frozen**; changes go through the orchestrator. |
| **P1** pixel + SDK | 5.5 → 5.6 → 5.7 | `apps/pixel/src/**`, `apps/pixel/e2e/**` (not `prd006.spec.ts`), `packages/experiment-core/**`, `packages/next/**`, `packages/react/**`, `packages/dom/**` (only if needed), `docs/integrations/**` | gates + G3 + bundle size | Cookie codec stays backward compatible (4- and 5-field). |
| **P2** ingest + FX | 5.3 → 5.4 → 5.19 | `apps/edge/src/**`, `apps/collector/src/db/row-mapper.ts`, `apps/collector/src/consumer/**`, `apps/collector/src/db/clickhouse.ts`, `apps/collector/src/ingest/**` (validation only), `apps/collector/src/fx/**` | gates + G3 | |
| **P3** stats | 5.10 → 5.11 | `apps/collector/src/stats/**` (keep `index.ts` signature) | gates + G3 | Pure module + one stateless route. |
| **P4** modeler + sync API | 5.9 → 5.15 → 5.8 | `apps/collector/src/modeler/**`, `apps/collector/src/sync/**`, `apps/collector/src/config.ts` (env additions) | gates + G3 | Insert fixture rows straight into `events` / `event_items` (don't wait for P2). FX: seed `fx_rates_history` directly (don't wait for 5.19). |
| **P5** validation harness | 5.14 (all but the full run) | `scripts/e2e/prd006/**`, `apps/pixel/e2e/prd006.spec.ts`, root `package.json` (`prd006:validate` only), `.github/workflows/ci.yml` (new job only) | `bun test scripts/e2e/prd006`, `--dry-run`, G3 | Must not import collector source. |
| **P7** products + distributions | 5.16 | `apps/collector/src/products/**`, `apps/collector/src/distributions/**` | gates + G3 | View runners only (no routes). |
| **P8** health | 5.17 | `apps/collector/src/health/**` | gates + G3 | SRM: S3 helper if merged, else local copy + request. |
| **P6** integrate | merge P2, P3, P4, P7, P8, P1, P5 (G3 after each) → requests → 5.12 → `pnpm prd006:validate` | everything (integration), `tasks/README.md`, `tasks/RUN_LOG.md`, `docs/prds/006-validation-report.md` | full validation green | Fix failures with focused follow-ups in the owning package's paths. |

## crobot packages

Task files: `../crobot/tasks/analytics-v2/C*.md`. Spec:
`../crobot/tasks/prd-analytics-v2.md`. Rules: `tasks/phase-5/LOOP.md`
(same loop; crobot gates below).

| Pkg | Tasks (in order) | Owns (may edit) | Gates |
|---|---|---|---|
| **CA** config | C0 → C8 → C10 | `app/Domain/Experimentation/**` (version enum, resolver, stamping), Filament project action, goal editor + settings, wizard v2 branch, their migrations and tests | crobot gate |
| **CB** data + sync | C1 → C9 | `app/Domain/Analytics/{Clients,DTO,Repositories,Jobs}/**`, `AnalyticsSubscriptionService`, `AnalyticsWebhookController`, `VerifyAnalyticsWebhook`, analytics migrations, `config/services.php` (testa_analytics), `tests/Fixtures/testa/**`, `app/Console/Kernel.php` (v2 branch only) | crobot gate |
| **CC** services + views | C2 → C3 | `app/Domain/Analytics/Services/{MetricCatalogue,GoalMetricMapper,MetricDeriver,PlanningService,StatusLabeler,AnalyticsViewService}.php`, `app/Domain/Analytics/Normalizers/**`, `ExperimentAnalyticsController` | crobot gate |
| **CD** UI | C4 → C5 → C6 → C7 | `resources/js/pages/analytics/**`, `resources/sass/pages/analytics/**`, `RecommendationService`, view-service methods for C5–C7 | crobot gate + manual wireframe check (screenshots in log) |
| **C-INT** integrate | merge CA, CB, CC, CD into `feat/analytics-v2`; mock-mode acceptance (PRD §9) | everything (integration) | crobot gate + F1 acceptance in mock mode |

**Crobot gate** (inside `crb-php` in the worktree): `php artisan test`,
`vendor/bin/phpstan analyse`, `npm run build`.

**Shared crobot files** (`routes/api.php`, `app/Http/Kernel.php`): CA, CB
and CC each add only their own clearly commented block; the orchestrator
resolves merge conflicts there.

## Cross-repo

| Pkg | When | What |
|---|---|---|
| **X1** acceptance | after P6 and C-INT | In testa-platform `pnpm prd006:validate --keep-up --only F1`; in crobot set `TESTA_ANALYTICS_MOCK=false`, `TESTA_COLLECTOR_API_URL=http://host.docker.internal:8090`, the service token and webhook secret; run crobot PRD §9 acceptance against the live stack; screenshots in the log. |
