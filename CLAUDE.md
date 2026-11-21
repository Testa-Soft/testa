# CLAUDE.md

Guidance for Claude Code in **testa-platform**. Read [`AGENTS.md`](./AGENTS.md) too: it is the repo contract (conventions, guardrails, task workflow). This file explains how the repo fits into the rest of Testa.

## Testa at a glance

Testa is an A/B testing / CRO product. Customers create experiments in a dashboard, put a script or SDK on their site, and read results. The product is split across several repos:

| Repo | Local checkout | Remote | Stack | Owns |
|---|---|---|---|---|
| **crobot** | `~/projects/crobot` | `bagdaddy/crobot` | Laravel 10 (PHP 8.2), Vue 3, Filament 3, MySQL | Source of truth for clients, projects, experiments, variations, goals, billing, auth (Passport). Public REST API (`/api`), staff admin (`/admin`, Filament), the **v1** script + v1 results, the CRO Auditor. Proxies v2 analytics to the collector. |
| **testa-admin** | `~/PhpStormProjects/testa-admin` (`Testa-Soft/testa-admin`), `~/projects/testa-admin` (`bagdaddy/testa-admin`, where the v2/redesign branches live) | see left | Next.js 15 App Router, shadcn/ui, yarn | The customer dashboard. Talks **only** to the crobot API (`NEXT_PUBLIC_API_URL`); types are generated from crobot's Swagger (`yarn generate:ts`). |
| **testa-platform** (this repo) | `~/projects/testa-platform` | `Testa-Soft/testa` | TypeScript: pnpm + Turborepo, Bun, Hono, Cloudflare Workers, ClickHouse, Redis | Everything **v2**: npm SDKs, the 4.0 pixel, edge worker, collector (ingest, warehouse, config API, metric modeler). |
| testa-mcp | `~/projects/testa-mcp` | none (local only; deploy branch `staging`) | CF Worker, MCP | Lets Claude author, preview and publish experiments through the crobot API. |
| testa-marketing-web | `~/PhpStormProjects/testa-marketing-web` | `Testa-Soft/testa-web` | Next.js | Marketing site and native landing. It also dogfoods `@testa-soft/next`. |
| testa-demo | `~/projects/testa-demo` | not a git repo | shell | Local full-stack demo (`demo.sh up/down/status/smoke`) and runbooks such as `STAGE1_RUNBOOK.md`. |

Each sibling repo has its own `CLAUDE.md`. Read it before you edit that repo.

Cross-repo planning:
- Strategic plan (read-only): `~/.claude/plans/mossy-honking-hare.md`
- Living roadmap: `crobot/docs/ANALYTICS_OVERHAUL_ROADMAP.md`
- Frozen admin-v2 API contract: crobot `tasks/admin-v2/CONTRACT.md` (copy in `tasks/admin-v2/`)

### How the pieces talk

```
testa-admin (dashboard) ──REST──▶ crobot /api ◀── testa-mcp (Claude)
                                     │  ▲
     publish config (Bearer) ────────┘  │ v2 analytics proxied from the collector read API
                                     ▼  │
                           collector (this repo) ── ClickHouse, Redis
                              ▲  config API: config.testa-soft.tech/api/v1/config/{projectId}
                              │ HMAC /_ingest
customer site ── SDK/pixel ──▶ edge worker /track
              └─────────────▶ crobot /api/leads, /api/leads/convert   (legacy v1 tracking)
```

## v1 vs v2

"Version" means **which analytics stack an experiment runs on**. In crobot this is the `PlatformVersion` enum (`v1` | `v2`). The only class allowed to decide it is `App\Domain\Experimentation\Services\ExperimentVersionResolver`. The column `experiments.platform_version` is stamped when the experiment is created and can never change afterwards (the model throws if you try). `projects.platform_version` defaults to `v1` and decides which version new experiments get.

| | **v1 (legacy)** | **v2 (this repo)** |
|---|---|---|
| Client code | Hand-written `script.js` in crobot `resources/js/integration/<ver>/` (3.x; 3.6 is the latest). `php artisan generate:script` turns it into per-project `public/projects/{uuid}.js`, loaded via the customer's SmartCode snippet. | npm SDKs `@testa-soft/next`, `@testa-soft/react` (built on `@testa-soft/experiment-core` + `@testa-soft/dom`), plus the 4.0 pixel in `apps/pixel` for script-tag customers. |
| Experiment config | Baked into the generated per-project JS by crobot. | crobot POSTs it to the collector config API (`buildTestaConfig`). SDKs fetch it from `config.testa-soft.tech` (CDN-cached, geo spliced in by `apps/config-geo`). |
| Exposure | `POST crobot /api/leads` creates a `leads` row: the impression, one per (experiment, visitor). | `experiment_view` event: edge `/track` → collector `/_ingest` → Redis stream → ClickHouse. |
| Conversion | `POST crobot /api/leads/convert` creates a `lead_completed_goals` row, and only if an exposure lead exists. | Raw events (`conversion`, `page_view`, `purchase`, …) stored in ClickHouse. Attribution to the experiment happens at query time, joined on `visitor_id`. |
| Storage | MySQL (crobot) | ClickHouse (13-month TTL) |
| Goals | `click`, `page_view`, `custom` (`window.Analytica.pushEvent`), defined per experiment. | Goals are views over data that is always collected. Page-view and custom goals can be added retroactively; only click goals are matched in the browser. Adds ecommerce, funnel and guardrail goals and a per-project **goal library** (`project_goals`). |
| Results | `cache:experiment-statistics` cron plus the `stats/compare-groups` microservice; API `/api/goals/{id}/results` (route guard `experiment.version:v1`); Vue `GoalResults`. | Collector metric modeler; crobot `/api/experiments/{id}/analytics/*` (guard `experiment.version:v2`); Analytics V2 pages in crobot and the redesigned testa-admin. |
| Cookies | `_testa_uuid`, per-experiment `_testa_exp_<id>` / `_testa_ses_<id>` / `_testa_user_<id>` | `_testa_uuid` (+ HttpOnly backup `_testa_uuid_s`), one packed `_testa_exp`, `_testa_persist` consent marker. Session-scoped until consent is granted; see `docs/architecture/04-cookies-and-consent.md`. |

Rules that follow from this:
- **v1 must keep working exactly as before.** Never remove or reroute legacy `/api/leads` traffic or the `leads`/`lead_completed_goals` path. The SDKs still send legacy exposure and conversion calls, so v1 results stay correct.
- **Don't branch on version yourself.** Use `ExperimentVersionResolver` and the route middleware. A v1 experiment hitting a v2 endpoint (or the reverse) gets a 409 (`VersionMismatchException`).
- **Switching a project.** A staff-only Filament action, "Migrate project to v2" (`ProjectVersionMigrator`), moves the project and its never-started experiments to v2. Experiments that already started keep v1 and their results. Rollback is refused once v2 experiments have started.
- **Rollout.** Stage 1 = the redesigned admin plus MCP, with every project still on v1. Stage 2 = v2 *alongside* v1 per project: `projects.v2_enabled`, and the version is picked per experiment at creation. Stage 2 currently lives on feature branches (crobot `feat/v2-alongside-v1`, admin `feat/v2-version-picker`), not on staging.

## This repo

```
apps/
  pixel/        4.0 script-tag SDK (loader + runtime). Gateway over experiment-core/dom. Vitest + Playwright.
  edge/         Cloudflare Worker: /track, first-party cookies, enrichment, bot filter, HMAC batches to the collector. Vitest.
  collector/    Bun + Hono: /_ingest, Redis-stream consumer → ClickHouse, config API, metrics/analytics read API, modeler. `bun test`.
  config-geo/   CF Worker that splices visitor geo into the cached config JSON.
packages/
  shared-types/     @testa-platform/shared-types (private): Event, ProjectConfig, ConsentState, PII scrubbers (runtime).
  experiment-core/  @testa-soft/experiment-core: host-neutral bucketing (xxhash32(visitor:experiment) mod 100), targeting, redirects, cookies, consent.
  dom/              @testa-soft/dom: DOM changes, goal tracking, anti-flicker controller.
  react/            @testa-soft/react: TestaProvider, track*, consent API.
  next/             @testa-soft/next: proxy/middleware (split-URL 307s, exposures), /server TestaProvider, Pages Router entry.
docs/architecture/  00-overview … 06-system-diagram. Read 00 first.
docs/prds/          004–007. tasks/ holds phase task files + tasks/README.md index.
scripts/e2e/        Cross-repo e2e (`pnpm e2e:cross`, real crobot + collector), PRD-006 validation.
deploy/             Fly / staging runbooks (`deploy/staging/README.md`).
```

The four `@testa-soft/*` packages are published to npm in lockstep (same version, `workspace:*` cross-deps). Publish with `pnpm -r publish` from the repo root; it needs the owner's npm OTP. Nothing reaches customers until it is published.

## Working here

```sh
pnpm install
docker compose up -d                        # Redis on host :6380, ClickHouse
pnpm -r typecheck && pnpm -r test && pnpm lint   # must pass before any commit
```

- Strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `import type`, explicit `.ts` relative imports, Biome. TS files stay under 400 lines.
- Collector tests flush Redis DBs 7–11. Live harnesses use DB ≥ 12 (`REDIS_URL=redis://localhost:6380 REDIS_TEST_DB=12`).
- Privacy: never store IPs or personal data. Events go through `scrubEvent`/`scrubProps`/`scrubUrl` in the SDK, the edge and the collector.
- The pixel must preserve the legacy `window.Analytica.*` globals. Anti-flicker is the customer SmartCode's job, not the pixel's.
- While the owner is the sole reviewer, push straight to `main` (this overrides the PR flow in AGENTS.md). CI failures email the owner, so keep `main` green.

## Environments

- **Production:** crobot `master` (`cdn.testa-soft.tech/api`); collector Fly app `testa-collector` behind `config.testa-soft.tech` (serves live customer configs: never redeploy or touch without approval). Admin on Vercel. MCP prod = testa-mcp `staging` branch, `wrangler deploy --env production`.
- **Staging:**
  - crobot `staging` auto-deploys to Forge `testa-staging.on-forge.com`.
  - Fly apps `testa-collector-staging`, `testa-staging-clickhouse`, `testa-staging-redis`, deployed from this repo's `staging` branch.
  - Admin is on Vercel and not Git-connected: deploys are CLI uploads.
  - Pushing to staging branches is fine without asking. Production always needs approval.
- **Local:**
  - crobot runs in docker (`crb-php`, Redis `crb-redis` on :6379).
  - This repo's Redis is on :6380.
  - The full demo stack is in `~/projects/testa-demo`: crobot :8288, collector :8093, admin :3400, MCP :8787, landing :3300.
