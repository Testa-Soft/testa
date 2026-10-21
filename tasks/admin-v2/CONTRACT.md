# Admin v2 backend — frozen contract

Source of truth for every agent in the admin-v2 rollout. Design doc (human-facing):
https://claude.ai/code/artifact/801c2399-5220-48d8-beee-65a561240677

Rules:
- Everything is **additive**. Existing fields keep their meaning (the MCP and the v1 admin must keep working).
- v2-only behaviour stays behind the existing `experiment.version:v2` guard / `platform_version = v2`. v1 projects see no change.
- Every new or changed endpoint gets `@OA` (l5-swagger) annotations in the same branch.
- If you find the contract wrong or impossible, STOP that part, write the problem in your report, and keep going with the rest. Do not invent a different shape silently.

## Settled product decisions

1. Goals are **views over data collected anyway**. Ecommerce events, custom events and (new) page views are stored raw, so a goal added later shows its full history; removing a goal only hides it.
2. **Click goals are the exception**: the browser matches configured selectors and sends `conversion` with `goal_id`; they only have data from when they were configured. A click goal's rule change = a new goal row (new id). Every other goal type may be edited in place.
3. `rank: primary` is **display order only** (the metric shown first). At most one per experiment; none is valid.
4. `count_mode: every` ships **with stats** (stats are computed on demand for the selected range).
5. Goal name and event name are separate catalogue fields (E4 "Contact details" fires on `add_shipping_info`; E5 "Payment load" on `add_payment_info`).
6. Login must **not** revoke the user's other sessions. Add an explicit "log out other devices".
7. Projects over the 30-goal library cap after backfill keep all goals; adds are blocked (409) until under 30.
8. Page-view goals are computed from stored page views (stateless metric key, below). In-experiment page views are retained **13 months** (was 30 days).

## Goal codes

| Code | goals.type | metric id | base |
|---|---|---|---|
| E1 | purchase | cr | visitors |
| E2 | add_to_cart | add_to_cart_rate | visitors |
| E3 | begin_checkout | begin_checkout_rate | visitors |
| E4 | contact_details | contact_details_rate | visitors |
| E5 | payment_load | payment_load_rate | visitors |
| E6 | lead_register | lead_rate | visitors |
| E7 | upsell | upsell_rate | visitors (visitors with an additional purchase ÷ visitors, since 2026-10-21) |
| F1 | step_cart_to_checkout | step_cart_to_checkout | add_to_cart |
| F2 | step_checkout_to_contact | step_checkout_to_contact | begin_checkout |
| F3 | step_contact_to_payment | step_contact_to_payment | add_shipping_info |
| F4 | step_payment_to_purchase | step_payment_to_purchase | add_payment_info |
| G1, G2… | click / page_view / custom | `goal:<id>` (click, custom) or `page:…` (page_view) | visitors |

Preset codes live in ONE PHP catalogue: `App\Domain\Analytics\Services\GoalPresetCatalogue` (Goals agent creates the code→type map; Tracking agent extends it with names, events and parameters).

`kind` (derived, never stored): `ecommerce` for E*, `funnel` for F*, `custom` for G*.

## Schema (crobot) — Goals agent owns all migrations below

`goals` add:
- `code` varchar(8) NOT NULL (backfilled)
- `project_goal_id` FK nullable → `project_goals.id` (set for click/page_view/custom)
- `count_mode` enum(`unique`,`every`) default `unique` (`every` only for custom goal types)
- `match_type` enum gains `starts_with`

`project_goals` (new): `id`, `project_id` FK, `code` varchar(8), `title`, `type` enum(click,page_view,custom), `action`, `match_type` nullable, `rule_hash` char(40) = sha1(type|normalised action|match_type), `in_library` bool default true, timestamps, `deleted_at`. Unique (`project_id`,`code`). Unique (`project_id`,`rule_hash`) among non-deleted rows (enforce in code if MySQL can't with soft deletes).

`analytics_settings` / `analytics_defaults` add `disabled_goals: list<string>` (since 2026-10-21): built-in codes E1–E7 / F1–F4 switched off for the experiment (views only; data is still collected). Upper-cased, each once; the primary goal can't be disabled (422 `disabled_goals`).

Goal preferences: `GET /projects/{uuid}/analytics/defaults` → `{data: AnalyticsSettings}` (any v2 project member); `PUT` same body as experiment settings, merged (ADMIN, SUPER_ADMIN, ANALYST). New v2 experiments copy them when the create request sends no `analytics_settings`.

`projects` add: `next_goal_number` int unsigned default 1 (incremented under row lock; codes never reused), `analytics_defaults` JSON nullable (same shape as `experiments.analytics_settings`; copied into a new v2 experiment's `analytics_settings` at create when the request doesn't send one).

Backfill migration: per project, group existing click/page_view/custom goals by `rule_hash`, create one `project_goals` row per group numbered G1.. by oldest goal id, link goals, set `goals.code`; preset goals get their E/F code; set `next_goal_number`.

## Metric keys (crobot ↔ collector)

Existing: built-ins, `event:<name>`, `goal:<id>`.
New: `page:<match_type>:<value>` where `match_type` ∈ `exact|contains|starts_with|regex` and `<value>` = `encodeURIComponent(action)` (PHP: `rawurlencode`). Max key length 1024. Collector computes it per visitor from stored `page_view` events (post-exposure, same windowing as other keys) using the **same URL semantics as the pixel's `urlMatchesGoal`** (`packages/dom/src/goals/controller.ts`). `GoalMetricMapper` maps page_view goals to this key (no longer `goal:<id>`).

Daily metric rows gain `count_sq_visitor` (Σ over visitors of n², n = per-visitor count) so `count_mode: every` can have stats (mean count per visitor). Stats for `every` goals use the count model.

## Analytics API (crobot) — Analytics agent

Envelope of every `GET /experiments/{experiment}/analytics/{view}` adds:
- `currency`: ISO 4217 from `projects.reporting_currency` (default EUR)
- `retry_after_ms`: integer while anything in the response is pending, else null
- status vocabulary everywhere (envelope `stats.status` and section `status`): `ready | pending | no_data | error`. Keep old values available under `status_detail` for one release so the MCP doesn't break. `no_data` = experiment never started or has no rows (never polls forever).

Routing: analytics routes also accept the experiment identifier as `/experiments/i:{identifier}/analytics/...` (project-scoped like the rest).

`goal-table`:
- `goal` param accepts a goal id **or** a code (`E1`, `F2`, `G4`). E/F codes resolve even if no goal row exists on the experiment (goals are views).
- `goals[]` items add `code`, `kind`, `base_label` ("Visitors", "Reached add_to_cart"…), `count_mode`, `totals {visitors, conversions, events}`, and `by_variation[] {variation_id, value, uplift, label, stats}` (every variation). `best` stays.
- `selected` adds `code`, `base_label`, `count_mode`.

New project-level catalogue: `GET /projects/{uuid}/analytics/catalogue` →
```
{ data: { metrics: [{id,label,group,formula,direction,kind,stats_model}],
          dimensions: [<breakdown dimension ids>],
          goal_presets: [{code,type,kind,name,event,qualifier|null,formula,base,base_label,
                          params:[{name,type,required,example,description}]}] } }
```
with ETag. (`goal_presets[].params` may be empty until the Tracking agent fills them.)

## Experiments API (crobot) — Goals agent

`POST /experiments`, `PUT /experiments/{identifier}` `goals[]` accept three forms (v2 only; v1 unchanged):
- preset: `{ code: "E1", rank }`
- library: `{ code: "G4", rank }`
- custom: `{ title, type: click|page_view|custom, action, match_type?, count_mode?, rank, save_to_library? (default true) }`
Existing `{id, ..., removing: true}` semantics keep working.

Validation → 422 `{ error: "invalid_goals", index, reason }`: more than one primary; duplicate code on one experiment; unknown code; `count_mode: every` on a preset; `match_type` given for non-page_view is **dropped silently (stored null)**, missing for page_view → 422.

`GET /experiments/{identifier}` `goals[]` add: `code`, `kind`, `count_mode`, `project_goal_id`, `in_library`.
`GET /experiments/filter` items add `updated_at` and `goal_codes[]`.

`starts_with` is stored as such. The collector config builder (testa-platform `apps/collector/src/config/build.ts`) compiles it for the pixel to `regex` `^` + escaped value (Collector agent).

## Goal library (crobot) — Library agent

- `GET /projects/{uuid}/goals?scope=library|all` → `{ data:[{code,title,type,action,match_type,in_library,used_in,created_at}], cap:30, count }`
- `POST /projects/{uuid}/goals` → 201; 409 `library_full`; 409 `duplicate_rule` (+ existing `code`)
- `PATCH /projects/{uuid}/goals/{code}` → rename / change rule / toggle `in_library`. Experiments are untouched.
- `DELETE /projects/{uuid}/goals/{code}` → soft delete; code retired.
Reads: any project member. Writes: ADMIN, SUPER_ADMIN, ANALYST.
`used_in` = count of non-deleted `goals` rows with that `project_goal_id`.

## Tracking (collector + crobot) — Collector agent, Tracking agent

Collector (Bearer, same auth as config API):
- `GET /api/v1/projects/{projectId}/tracking/events?events=a,b` → `{ events:[{event, last_received_at|null, received_24h, params:[{name, present_pct, last_seen_at|null}]}] }` over raw events of the project (not experiment-scoped). Look-back: 30 days for last_received, 24 h for counts/params.
- `GET /api/v1/projects/{projectId}/tracking/hits?event=<name>&since=<ISO>&limit=50` → recent raw hits with their params, read so Buffer flush lag doesn't hide them (`events_buffer`/`merge`).

crobot (proxies + judgement):
- `GET /projects/{uuid}/tracking/events` → per preset code `{code, event, status: receiving|stale|never, last_received_at, received_24h, params:[{name, status: ok|missing|invalid, last_seen_at}]}`; receiving = seen in 24 h, stale = seen in 30 d not 24 h. Cached 60 s.
- `POST /projects/{uuid}/tracking/listen {code}` → `{id, code, started_at, expires_at}` (Redis, 10 min TTL)
- `GET /projects/{uuid}/tracking/listen/{id}` → `{id, code, status: listening|expired, hits:[{received_at, params:[{name,value,status}]}]}`

## Sessions (crobot) — Sessions agent

- Login no longer calls a revoke-all; tokens are per device/session.
- `POST /auth/logout-others` (name may follow existing route conventions) revokes every AUTH/REFRESH token of the user except the caller's.
- Expose access-token lifetime: login/refresh responses include `expires_in` (seconds).
