# Tasks index

Each task = one focused PR. Agents pick the lowest-numbered `pending` task whose `blocked_by` is empty, work it through to a green PR, mark it `done`, and move on.

**Read order for any new task:**

1. The task file itself.
2. Linked architecture / reference docs.
3. `AGENTS.md` for repo-wide conventions.

**Status legend:** `pending` (open, ready to claim) · `in_progress` (claimed, work happening) · `blocked` (depends on a pending task) · `done` (PR merged) · `cancelled` (no longer needed).

> **2026-06-12 — board reconciled against git history.** The status table had drifted behind the code. Closed out as `done`: **1.2** (migrate runner), **1.4** + **1.5** (subsumed by PRD-001 ingest pipeline, `81f5ede`), **3.6** (`e26930c`), **3.10** (`5012248`/`38115de`), **3.14** (`fc444dd`). Genuinely still open: **1.6**, **1.7**, **2.8**, **2.9** (human-gated), **3.11**, **3.13**, **3.15**; **3.7** stays `in_progress` (audience engine shipped, but `visitor.custom` sandbox + legacy `targeting[]` evaluator deferred). Test baseline at reconciliation: pixel 317 + edge 90 + collector 41 = 448 green.

---

## Phase 0 — Bootstrap (DONE inline; no task files)

Foundation work was done in the seed commits before this task system existed. See git history (commits `f93652b` → `e095a0d` → `af0feb2`).

## Phase 1 — Collector ingest + write path

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [1.1](./phase-1/1.1-clickhouse-schema-files.md) | ClickHouse schema files | done | — |
| [1.2](./phase-1/1.2-migration-runner.md) | CH migration runner CLI | done | 1.1 |
| [1.3](./phase-1/1.3-clickhouse-singleton.md) | `@clickhouse/client` singleton | done | — |
| [1.4](./phase-1/1.4-ingest-route.md) | `POST /_ingest` route + HMAC + Zod | done | 1.3 |
| [1.5](./phase-1/1.5-consumer-worker.md) | Consumer worker (XREADGROUP → CH INSERT) | done | 1.1, 1.2, 1.3 |
| [1.6](./phase-1/1.6-fx-rates.md) | FX rates sync + dictionary endpoint | done | 1.3 |
| [1.7](./phase-1/1.7-tests.md) | Vitest coverage for ingest, consumer, replay | done | 1.4, 1.5 |
| [1.8](./phase-1/1.8-pageview-inexperiment-ttl.md) | page_view `in_experiment` column + differential TTL (PRD-002) | done | 1.1 |

## Phase 2 — Edge worker

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [2.1](./phase-2/2.1-hono-router.md) | Hono router skeleton (routes wired) | done | — |
| [2.2](./phase-2/2.2-cookies.md) | First-party cookie module | done | — |
| [2.3](./phase-2/2.3-enrich.md) | Geo + UA enrichment | done | — |
| [2.4](./phase-2/2.4-bot-filter.md) | Bot heuristics (free signals) | done | 2.3 |
| [2.5](./phase-2/2.5-batch-buffer-do.md) | DurableObject batch buffer | done | — |
| [2.6](./phase-2/2.6-ingest-forward.md) | HMAC sign + POST to collector | done | 2.5 |
| [2.7](./phase-2/2.7-serve-pixel.md) | GET /projects/:slug.js — KV serve | done | — |
| [2.8](./phase-2/2.8-tests.md) | miniflare + Vitest coverage | done | 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7 |
| [2.9](./phase-2/2.9-staging-deploy.md) | wrangler deploy to staging — **PAUSE** for human | pending | 2.8 |

## Phase 3 — Tracker pixel 4.0

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [3.1](./phase-3/3.1-loader-stub.md) | Loader stub + queue + monkey-patch installer | done | — |
| [3.2](./phase-3/3.2-runtime-entry.md) | Runtime entry + queue hydration + `_testa.load()` | done | 3.1 |
| [3.3](./phase-3/3.3-cookies-module.md) | Cookie module (7 cookies inc. freq + mutex) | done | — |
| [3.4](./phase-3/3.4-consent-state-machine.md) | Consent state machine + CMP integration | done | — |
| [3.5](./phase-3/3.5-spa-navigation.md) | SPA navigation (patch consumer + canonical URL diff) | done | 3.1 |
| [3.6](./phase-3/3.6-idb-outbox-transport.md) | IDB outbox + transport + retry + `_pixel_health` | done | 3.4 |
| [3.7](./phase-3/3.7-audience-rule-engine.md) | Audience rule engine + sandboxed JS evaluator + legacy compat | in_progress | — |
| [3.8](./phase-3/3.8-traffic-assignment.md) | Variation traffic assignment (xxhash32 + freq + mutex) | done | 3.3 |
| [3.9](./phase-3/3.9-variation-apply.md) | Variation apply (CSS / HTML / text / attr / JS) | done | 3.8 |
| [3.10](./phase-3/3.10-redirect-engine.md) | Redirect engine (decide + execute + loop guard + cross-domain + SPA) | done | 3.7, 3.8 |
| [3.11](./phase-3/3.11-spa-redirect-harness.md) | SPA redirect repro harness (Next 12/13/14, RR6, plain JS) | pending | 3.10 |
| [3.12](./phase-3/3.12-legacy-globals-compat.md) | `window.Analytica.*` legacy globals + eventEmitter | done | 3.2, 3.3, 3.8 |
| [3.13](./phase-3/3.13-legacy-http-calls.md) | Legacy HTTP calls (`/api/leads`, `/api/leads/convert`, `/api/pixel`) | pending | 3.12 |
| [3.14](./phase-3/3.14-bundle-build.md) | esbuild loader + runtime, content-hashed runtime URL | done | 3.1, 3.2 |
| [3.15](./phase-3/3.15-test-coverage.md) | Vitest coverage + Playwright golden flows | pending | 3.1–3.13 |
| [3.16](./phase-3/3.16-storage-consolidation.md) | Storage consolidation — one packed `_testa_exp` cookie (supersedes 3.3 per-experiment layout) | pending | 3.3 |
| [3.16](./phase-3/3.16-pageview-emission.md) | page_view emission (`in_experiment`, 50/session cap, crawler guard) (PRD-002) | pending | 3.5, 3.8 |

The Phase 3 corpus reflects the 2026-05-06 grilling decisions: anti-flicker is the customer's SmartCode's job (no shielding in 3.x); redirect engine is state-of-the-art and pulled forward (no 1:1 port of 3.6 redirect bugs); audience targeting uses the new `AudienceCondition` schema (`docs/reference/audience-schema.md`); event delivery uses an IndexedDB outbox + UUIDv7 + deterministic Redis stream IDs for dedup; `window.Analytica.*` is a frozen API surface (`docs/reference/legacy-globals-inventory.md`).

## Phase 4 — Collector read API

> **2026-10-14 — cancelled, superseded by Phase 5 / PRD-006** (flat report endpoint + Bayesian stats replace the per-metric MV endpoints and Welch/bootstrap).

Serves crobot's `MetricsProxyController` the pre-aggregated metrics in `packages/shared-types/src/metric-summary.ts` — AOV, RPV, sessions, funnel — computed over the ClickHouse daily MVs (migrations 003–007) + the `fx_rates` dictionary (1.6), gated by a service token. Read path drawn in `docs/architecture/diagrams/03-read-path.mmd`. Scoped 2026-08-05 against the existing MV/type contract.

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [4.1](./phase-4/4.1-read-api-auth-router.md) | Read-API router skeleton + `X-Service-Token` auth + param validation | cancelled — superseded by Phase 5 (PRD-006) | — |
| [4.2](./phase-4/4.2-statistics-module.md) | Statistics — Welch's t-test + seeded bootstrap CI/significance | cancelled — superseded by Phase 5 (PRD-006) | — |
| [4.3](./phase-4/4.3-query-layer-fx.md) | Metrics query layer over the MVs + FX conversion (`dictGet`) | cancelled — superseded by Phase 5 (PRD-006) | 4.1 |
| [4.4](./phase-4/4.4-aov-endpoint.md) | `GET /api/v1/metrics/aov` → `AovSummary` (Welch significance) | cancelled — superseded by Phase 5 (PRD-006) | 4.2, 4.3 |
| [4.5](./phase-4/4.5-rpv-endpoint.md) | `GET /api/v1/metrics/rpv` → `RpvSummary` (bootstrap, exposed-visitor denominator) | cancelled — superseded by Phase 5 (PRD-006) | 4.2, 4.3 |
| [4.6](./phase-4/4.6-sessions-endpoint.md) | `GET /api/v1/metrics/sessions` → `SessionsSummary` | cancelled — superseded by Phase 5 (PRD-006) | 4.3 |
| [4.7](./phase-4/4.7-funnel-endpoint.md) | `GET /api/v1/metrics/funnel` → `FunnelSummary` (`windowFunnel`) | cancelled — superseded by Phase 5 (PRD-006) | 4.3 |
| [4.8](./phase-4/4.8-read-api-integration-tests.md) | Read-API integration tests (live CH) + coverage gate | cancelled — superseded by Phase 5 (PRD-006) | 4.4, 4.5, 4.6, 4.7 |

## Phase 5 — Ecommerce metrics + sync API (PRD-006)

Implements `docs/prds/006-ecommerce-events-and-metric-modeling.md` (**Parts 5–6 win**). Supersedes Phase 4. Crobot's side: `../crobot/tasks/prd-analytics-v2.md` + `../crobot/tasks/analytics-v2/`.

**Start here:** one orchestrator following [`orchestration/ORCHESTRATOR.md`](./orchestration/ORCHESTRATOR.md) hands **work packages** ([`orchestration/PACKAGES.md`](./orchestration/PACKAGES.md)) to worker sessions by ID, each in its own git worktree. Per-task rules: [`phase-5/LOOP.md`](./phase-5/LOOP.md). Validation spec: `docs/prds/006-validation.md`.

| ID | Task | Package | Status | Blocked by |
|---|---|---|---|---|
| [5.1](./phase-5/5.1-shared-types.md) | Shared types — envelope, Item, sync API + view + stats types | P0 | done — merged (`c3e2c04`) | — |
| [5.2](./phase-5/5.2-clickhouse-migrations.md) | ClickHouse migrations 013–023 | P0 | done — merged (`80bb9eb`) | — |
| [5.18](./phase-5/5.18-attribution-core-and-route-stubs.md) | Attribution core + sync/stats stubs + view registry | P0 | done — merged (`3219295`) | 5.1, 5.2 |
| [5.5](./phase-5/5.5-pixel-experiment-session.md) | Pixel — experiment session, `session_idx`, `exp` stamping | P1 | done — merged (`c5848e0`, `116d676`) | 5.1 |
| [5.6](./phase-5/5.6-pixel-attribution-fields.md) | Pixel — session-entry attribution, screen size, utm_term/content | P1 | done — merged (`8391557`) | 5.1 |
| [5.7](./phase-5/5.7-track-api-helpers.md) | Pixel + next/react — `track()` + typed helpers | P1 | done — merged (`6e40287`) | 5.5 |
| [5.3](./phase-5/5.3-edge-validation-enrichment.md) | Edge — Zod, alias, OS/browser split, referrer_domain, channel | P2 | done — merged (`544a5d6`) | 5.1 |
| [5.4](./phase-5/5.4-consumer-row-mapping.md) | Consumer — new columns + event_items fan-out | P2 | done — merged (`6b71520`) | 5.1, 5.2 |
| [5.19](./phase-5/5.19-fx-previous-day-and-backfill.md) | FX — previous-day rate, backfill, fallback | P2 | done — merged (`c5d021a`) | 5.1 |
| [5.10](./phase-5/5.10-bayesian-stats-module.md) | Bayesian Monte Carlo stats module | P3 | done — merged (`d7cb1ae`) | 5.1 |
| [5.11](./phase-5/5.11-stats-endpoint.md) | `POST /api/v1/stats` | P3 | done — merged (`db54724`) | 5.10 |
| [5.9](./phase-5/5.9-daily-rows-builder.md) | Daily rows builder (22 keys; + `units_upsell` R2) | P4 | done — merged (`3312f5f`) | 5.18 |
| [5.15](./phase-5/5.15-modeler-process.md) | Modeler process — scheduler, queue, workers, webhook | P4 | done — merged (`c678dbf`) | 5.9 |
| [5.8](./phase-5/5.8-sync-api-routes.md) | Sync API routes | P4 | done — merged (`6bb35e9`) | 5.15 |
| [5.14](./phase-5/5.14-e2e-validation-harness.md) | E2E validation harness | P5 | in progress (P5, not yet merged) | 5.1 |
| [5.16](./phase-5/5.16-products-distributions-views.md) | Products + distributions views | P7 | done — merged (`1cb630a`) | 5.18 |
| [5.17](./phase-5/5.17-health-view.md) | Health view | P8 | done — merged (`940fb10`) | 5.18 |
| [5.12](./phase-5/5.12-docs-update.md) | Docs update | P6 | done (part A docs; validation report = part B) | all |
| [5.13](./phase-5/5.13-crobot-handoff.md) | Crobot handoff (moved to the crobot repo) | — | cancelled | — |

**Follow-ups merged during integration** (from crobot requests R1–R4 in
`phase-5/logs/CROBOT-REQUESTS.md` and the X0 live harness):

| Fix | What | Merged |
|---|---|---|
| P4-fix1 | Config alias by numeric `project_id` + `platform_version` kept by the config build | `b9681b3` |
| P4-fix2 | R2 `units_upsell` daily-row key (+ oracle, additive samples) | `b4e856d` |
| P4-fix3 | R3 project-scoped sync API + modeler state (`project_id` on every experiment-scoped call) | `b097929` |
| P7-fix1 | R4 `distributions.capped` with `cap_outliers` | `6099edb` |

## Phase N — Next.js split-URL middleware (`@testa/next`)

Server-side, flicker-free split-URL redirects for Next.js customers (PRD [003](../docs/prds/003-nextjs-redirect-middleware.md)). **Scope grew well past the original v1** during the 2026-08-04 build: full split_url parity (traffic split + the `/100` bucketing bug fixed, targeting, rule exclusions, cross-domain inbound), the pixel⇄`experiment-core` merge (one shared impl — bucketing, packed cookie, redirect engine, cross-domain), `onVariationApplied`, and pre-prod hardening (see **Phase P**).

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [N.1](./phase-N/N.1-experiment-core-extraction.md) | Extract `packages/experiment-core` (+ pixel now imports it — full merge done) | done | — |
| [N.2](./phase-N/N.2-testa-next-scaffold.md) | `@testa/next` scaffold + `createTestaMiddleware()` + `NextCookieStore` + `_testa_uuid` minting | done | N.1 |
| [N.3](./phase-N/N.3-config-client.md) | `ConfigClient` — config fetch by projectId/host, in-instance TTL cache | done | N.2 |
| [N.4](./phase-N/N.4-redirect-decision-loop.md) | Redirect decision loop (page-gate → targeting/exclusions → assign → 307 + cookies) | done | N.2, N.3 |
| [N.5](./phase-N/N.5-soft-nav-m1-rsc.md) | Soft-nav M1 — middleware handles App-Router RSC navigation (prefetch-safe) | done | N.4 |
| [N.6](./phase-N/N.6-soft-nav-m2-router-guard.md) | Soft-nav M2 — `<TestaRouterGuard/>` client component (Pages-Router-static catch-all) | done | N.4 |
| [N.7](./phase-N/N.7-demo-app-playwright.md) | Example Next.js app — App-router demo done; Playwright moved to [P.5](./phase-P/P.5-playwright-e2e.md) | in_progress | N.5, N.6 |
| [N.8](./phase-N/N.8-crobot-config-publish.md) | crobot publish side — `GenerateProjectScriptHandler` POSTs to the config API (done, authed) | done | N.3 |
| [N.9](./phase-N/N.9-dom-apply-extraction.md) | Extract `packages/dom` (apply engine, ex-pixel) + anti-flicker shield | done | N.1 |
| [N.10](./phase-N/N.10-html-experiments.md) | HTML/DOM experiments in `@testa/next` — `<TestaExperiments/>` + `<TestaShield/>`; engine assigns DOM experiments server-side | done | N.4, N.9 |
| [N.11](./phase-N/N.11-html-experiments-e2e.md) | HTML-experiment demo + Playwright e2e (no-flicker, sticky, multi-experiment) | pending | N.10 |

**HTML/DOM experiments (2026-08-17).** Extended the plugin past split-URL: `@testa-platform/dom` (the pixel's apply engine — css/html/text/attr/js/hide/insert/move — extracted to a shared package, plus a new anti-flicker shield) now backs a client `<TestaExperiments/>` that applies the visitor's assigned variant, cookie-first. The middleware assigns DOM experiments server-side (deterministic, no client coin-flip) and the client renders them; `<TestaShield/>` hides content pre-paint with a timeout fallback so there's no control→variant flash. Same `@testa-platform/dom` + `experiment-core` will back a Vite/Lovable client SDK later.

---

## Phase P — Production hardening & deploy (`@testa/next` + collector)

Making the split_url middleware + config API prod-ready and deployable. Envable host (`createTestaMiddleware({ projectId })`), config-API Bearer-token auth, and exposure tracking (`→ /api/leads`) already LANDED (2026-08-04); the tasks below are what remains before prod.

| ID | Task | Status | Blocked by |
|---|---|---|---|
| [P.1](./phase-P/P.1-config-read-path-cdn.md) | Prod config read path — nginx-static + Cloudflare CDN (R2 `ConfigStore` optional) | pending | — |
| [P.2](./phase-P/P.2-deploy-collector.md) | Deploy collector (Forge daemon + nginx + Cloudflare; Hetzner, not Fly — see task) | pending | P.1 |
| [P.3](./phase-P/P.3-publish-testa-next.md) | Publish `@testa/next` to npm (tsup bundle ready) + client README | pending | — |
| [P.4](./phase-P/P.4-server-pageview-conversions.md) | Server-side `page_view` goal conversions (exposure already done; click/custom = pixel) | pending | — |
| [P.5](./phase-P/P.5-playwright-e2e.md) | Playwright browser e2e — no-flicker, sticky, targeting, traffic split, cross-domain | pending | — |
| [P.6](./phase-P/P.6-cookie-migration-plan.md) | Live-traffic cookie migration — 3.x per-experiment → packed `_testa_exp` | pending | — |

---

## Authoring future-phase tasks (meta-task)

If the routine runs out of pending unblocked tasks, the next-best work is **authoring the next phase's task files** itself, against the architecture + reference docs already in the repo. Conventions for that meta-task:

1. Pick the next un-scoped phase (3 → 4 → 5).
2. Use the existing task files (Phase 1, Phase 2) as templates — same frontmatter, same section headings.
3. Each task = one PR-sized chunk; cite specific files to create + reference docs.
4. Mark the task file `status: pending` (the human reviews on next PR).
5. Open a PR titled `docs(tasks): scope phase 3 — pixel 4.0 (1:1 port + new APIs)` with all the new task files in one commit.
6. Do NOT start implementing until those PRs are merged. The human gates the contract.

---

## Conventions for task files

Each task file has frontmatter:

```yaml
---
id: 1.4
title: ingest route
phase: 1
status: pending          # pending | in_progress | blocked | done | cancelled
estimate_days: 1
blocked_by: [1.3]
files_to_create:
  - apps/collector/src/ingest/route.ts
  - apps/collector/src/ingest/schema.ts
references:
  - docs/architecture/02-collector.md
  - docs/reference/hmac-protocol.md
  - docs/reference/event-shape.md
commits: []              # filled in when done
completed_at: null
---
```

Body sections (in order):

1. **Goal** — one paragraph, what this delivers.
2. **Context** — what already exists, what depends on this.
3. **Acceptance criteria** — bullet list of verifiable conditions.
4. **Implementation notes** — concrete guidance, code shape, traps.
5. **Tests** — what to write.
6. **Out of scope** — what NOT to build under this ID.
