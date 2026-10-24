# Crobot → testa-platform requests

Append-only. Crobot adds `## R<n> — <title>` (need, why, screen). The platform orchestrator answers under the same heading with `Answer:` (PRD section, or contract commit).

## R1 — `experiments[].platform_version` in project config

**Need:** `ProjectConfig.experiments[]` gets `platform_version: "v1" | "v2"` (missing = "v1").

**Why:**
- Crobot runs v1 and v2 experiments side by side in one project (crobot PRD §3a).
- The pixel / `@testa-soft/next` must apply PRD-006 tracking only to v2
  experiments: experiment sessions, `exp` stamping, and `experiment_view` to
  the edge.
- v1 experiments keep only the legacy `/api/leads` calls (task 3.13).

**Screen:** none (tracking).

**Proposed answer:** add the field in S0 (shared-types + project-config doc),
and gate the session / `exp` / `experiment_view` logic on it in S1. Also:
- `exp` lists only v2 experiments.
- The report / products / distributions / health endpoints return 409
  `version_mismatch` for a v1 experiment.

Answer (R1): accepted as proposed.
- PRD-006 §6.1 (decision row), §5.3 (pixel: v2 only), §5.5 (409).
- Tasks: 5.1 (type + doc), 5.5 (pixel gating + v1 regression test), 5.18 (`requireV2Experiment` guard).

## R2 — upsell units in the daily rows (for "Units sold")

**Need:** a daily-row key with units bought in **upsell** orders, e.g.
`units_upsell` (`converted` = visitors with an upsell, `count` = upsell units,
`sum` = upsell item revenue), or `units.count` documented as including upsell
units (it currently counts initial orders only, §2.3).

**Why:** 006-validation.md F1 "V2 dashboard metrics" defines *units sold* =
`units.count` + upsell units (variant = 4: 1 + 2 + 1 upsell). The rows carry
no upsell-unit count, so crobot can't derive it. Crobot (C2 MetricDeriver)
currently approximates upsell units with `upsell.count` (upsell orders),
which matches F1 only because the one upsell has one unit. Marked
`// TODO R2` in `app/Domain/Analytics/Services/MetricDeriver.php`.

**Screen:** All metrics → Units sold; Products & upsell tab.

Answer (R2): accepted, as a new **additive** daily-row key `units_upsell` (`units` keeps its §2.3 meaning: initial orders only).
- Row shape, same as `units`: `visitors` = exposed visitors; `converted` = visitors with ≥1 upsell order; `count` = upsell item units (Σ quantity over upsell orders' items); `sum` = upsell item revenue in report currency; `sum_sq` / `sum_sq_visitor` as for `units`.
- Crobot: *units sold* = `units.count + units_upsell.count` (006-validation F1 V2 table: variant 4 = 1 + 2 + 1). Replace the `// TODO R2` approximation once the key lands.
- Platform follow-up `P4-fix2`: shared-types `MetricKey` + modeler daily rows + oracle `generate.py` + regenerated samples (additive rows only; no existing value changes). Crobot fixtures refresh from the regenerated samples afterwards.

## R3 — experiment ids are only unique per project (orchestrator-raised, cross-tenant)

**Finding:** crobot `experiments.identifier` is account-level (`ExperimentManager`: latest + 1), so different clients reuse 1, 2, 3… The platform's ClickHouse tables are keyed `(project_id, experiment_id)`, but the sync API (`/api/v1/experiments/{id}/…`), `readSubscription(experimentId)`, Redis run-state keys and the webhook payload use `experiment_id` alone → two clients' experiments with the same identifier collide (subscriptions, run state, daily-summary responses).

Answer (R3) — decided by the orchestrator (contract change, both repos):
- Every experiment-scoped sync call carries the numeric `project_id`: PUT/DELETE subscription bodies (PUT already has it), and `?project_id=` on GET daily-summary, POST/GET queries (POST body already has it), DELETE subscription. Missing → 400 `invalid_body` field `project_id`; a project that doesn't own the experiment → 404 `experiment_not_found`.
- Platform keys ALL experiment state by `(project_id, experiment_id)`: metric_subscriptions lookups, Redis run/lock/queue/query keys, modeler jobs.
- Webhook payload adds `project_id`; crobot routes webhooks by `(project_id, identifier)`.
- shared-types change authorized (additive params + webhook field); flagged per AGENTS.md guardrail 8.
- Tests on both sides: two projects with the SAME experiment identifier stay isolated end to end (X0 seeds a second project with colliding identifiers).

## R4 — capped-order count for the Revenue tab

**Need:** with `cap_outliers: true`, the `distributions` result (or the summary query) reports how many initial orders were capped and at what value, per variation, e.g. `"capped": { "threshold": 412.5, "by_variation": { "100": 3, "101": 5 } }`.

**Why:** crobot task C6 (Revenue tab) shows "N orders capped at €X (p99)" next to the order-value histogram. Crobot can't derive it: the cap is computed in the platform (PRD-006 §6.3, p99 of pooled initial-order values).

**Screen:** Full report → Revenue (order value distribution).

**Crobot meanwhile:** shows the toggle and the histogram; the count reads "not reported yet" (`// TODO R4` in `RevenueNormalizer`).

Answer (R4): accepted as an **additive** field on the `distributions` result when `cap_outliers: true` (absent otherwise): `"capped": { "threshold": <number, report currency>, "by_variation": { "<variation_id>": <count of initial orders capped> } }` — threshold = the pooled p99 of initial-order values used for capping (PRD-006 §6.3). Variation ids are platform ids (identifiers); crobot maps them via PlatformIdMap like every other by-variation map. Platform follow-up `P7-fix1` (+ shared-types addition, flagged). Keep `// TODO R4` until it lands.
