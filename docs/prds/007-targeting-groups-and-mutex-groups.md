# PRD 007 — Targeting/Exclusion Groups + Mutually Exclusive Experiment Groups

> Status: **needs-triage** (functional plan agreed 2026-10-23; admin UI design pending from Mantas)
> Author: Claude (from 2026-10-23 session with Mantas)
> Depends on: PRD 006 (`platform_version: 'v2'` experiments), config API (collector `build.ts`)
> Related: `docs/reference/audience-schema.md` (4.0 `audience` tree), `packages/experiment-core/src/targeting.ts`, `packages/experiment-core/src/order.ts`

Two features, one PRD, because both change the same gate sequence in
`experiment-core`'s engine and the same crobot → collector → SDK config path.

- **Part A — Targeting/exclusion groups:** explicit AND/OR grouping of rules.
- **Part B — Mutually exclusive groups:** VWO-style traffic split *between*
  experiments, so a visitor is in at most one experiment of a group.

Both are **v2-only**. v1 experiments keep today's flat rules and evaluation,
byte for byte.

## Problem Statement

### A. Rules can't express negation across values, or mixed logic

Targeting rules are flat. `passesTargeting` (3.3.3 `shouldTarget` parity)
groups them by dimension: **OR within a dimension, AND across dimensions**.
That grouping is implicit and fixed, so:

- "Not from country A **and** not from country B" can't be expressed as
  targeting: `country ≠ A`, `country ≠ B` evaluates as `≠A OR ≠B`, which is true
  for everyone.
- "Country A **and** country B" looks like it works, but it actually runs as A
  **OR** B.
- Mixed logic such as `(device = mobile AND utm_source = x) OR country = US` is
  impossible.
- Exclusions are a flat OR: any match excludes. "Exclude A, exclude B" already
  means "not A and not B", but users can't see that, and there's no way to
  require several conditions together ("exclude only if cookie X **and**
  utm Y").

### B. No controlled split between competing experiments

Today mutual exclusion is an `experiment`-dimension exclusion rule plus a
deterministic per-visitor experiment order (`order.ts`). The result is a
roughly even split decided by order. You can't say "Exp 12 gets 40 %, Exp 15
gets 30 %, 30 % see neither", and in a funnel the first experiment a visitor
reaches captures almost everyone. The pixel's separate first-come
`mutex_group` string has the same funnel bias and doesn't exist in
experiment-core.

## Solution

### A. Two-level rule groups

```
Targeting   = Group₁ ⟨joiner⟩ Group₂ ⟨joiner⟩ …      top-level joiner: AND | OR (default AND)
Group       = cond ⟨joiner⟩ cond …                    one joiner per group: AND | OR
Exclusions  = same structure; excluded when the expression is TRUE
```

- Negation lives on the **condition** (`not_equals`, `not_contains`, new
  `not_in`). There are no NOT groups.
- New list operators **`in` / `not_in`**: "country not in [A, B]" is one
  condition.
- Targeting and exclusions stay **separate sections**. Exclusion also means
  "never counted in the experiment", which is a different meaning from
  targeting.
- Two levels is deliberate: it covers real cases (VWO and AB Tasty stop
  there) and keeps the builder UI simple.

### B. Mutually exclusive groups with explicit slots

A group belongs to a project and has 10 000 slots (0.01 % resolution). Each
member experiment owns a **contiguous slot range**. A visitor's slot is
`xxhash32("{visitorId}:{groupId}:mx") % 10000`, the same on every page and on
server and client alike. A visitor can only enroll in the experiment that owns
their slot. Unowned slots form the group's holdout: no group experiment.

```
Group "Checkout"
  ├─ Exp 12  [   0 – 3999]  40 %
  ├─ Exp 15  [4000 – 6999]  30 %
  └─ free    [7000 – 9999]  30 %   → holdout
```

## User Stories

1. As a CRO manager, I target "country not in [DE, AT]" with one condition and
   it excludes exactly those two countries.
2. As a CRO manager, I build `(mobile AND utm_source = fb) OR country = US`
   from two groups.
3. As a CRO manager, I add 30 cookie exclusions to one group labelled "Exclude
   if **any** of these match", and it behaves exactly like today's flat list.
4. As a CRO manager, I add an exclusion group "Exclude if **all** of these
   match" (cookie X and utm Y) without affecting the other exclusions.
5. As a CRO manager, I put two split-URL tests from the same control URL in a
   group at 50/50 and every visitor sees at most one of them.
6. As a CRO manager running landing / product / checkout tests in one group, I
   see an expected-enrolled-per-week estimate per experiment and tune the shares
   (e.g. 15 / 30 / 55) to even out sample sizes before launch.
7. As a CRO manager, I shrink a running experiment's share; visitors already in
   it stay in it, and no one ends up in two group experiments.
8. As a developer debugging, `debug: true` / URL tracing tells me a visitor was
   skipped because of `mutex_slot` / `mutex_taken`, or which targeting group
   failed.
9. As an existing v1 customer, nothing about my experiments changes.

## Implementation Decisions

### A1. Wire format (`packages/shared-types/src/project-config.ts`)

```ts
type Joiner = 'all' | 'any';
interface RuleGroup { [k in Joiner]?: TargetingCondition[] }        // exactly one key
interface RuleTree  { [k in Joiner]?: RuleGroup[] }                 // exactly one key

interface ExperimentConfig {
  // existing flat fields stay for v1 and as fallback
  targeting?: TargetingCondition[];
  exclusions?: TargetingCondition[];
  // v2: present → wins over the flat field of the same kind
  targeting_tree?: RuleTree;
  exclusion_tree?: RuleTree;
  mutex_group_id?: number;
}

interface TargetingCondition {
  dimension: string;
  operator: 'exact' | 'equals' | 'contains' | 'not_contains' | 'regex' | 'not_equals' | 'in' | 'not_in';
  value: string;        // single-value operators
  values?: string[];    // `in` / `not_in` only
}

interface ProjectConfig {
  mutex_groups?: { group_id: number; slots: { experiment_id: number; from: number; to: number }[] }[];
}
```

The exact TS spelling of the one-key unions is left to implementation (a
discriminated `{ joiner, conditions }` object is fine if it reads better). The
leaves stay `TargetingCondition`, so all dimension handling (`url`, `cookie`,
`device`, `region_country`, `experiment`, query-param fallback) is reused
unchanged.

### A2. Evaluation semantics (`experiment-core`)

- New `evaluateRuleTree(tree, ctx): 'true' | 'false' | 'unknown'`, next to
  `passesTargeting` and reusing its `evaluate()`.
- **Three-valued (Kleene) logic** for dimensions we can't evaluate (e.g. no geo
  signal):

  | AND | T | F | U |   | OR | T | F | U |
  |---|---|---|---|---|---|---|---|---|
  | **T** | T | F | U | | **T** | T | T | T |
  | **F** | F | F | F | | **F** | T | F | U |
  | **U** | U | F | U | | **U** | T | U | U |

  A final `unknown` means **not targeted** (targeting) and **not excluded**
  (exclusions). For single rules this is exactly today's fail policy.
- `in` / `not_in`: `in` is true if the resolved value equals any of `values`;
  `not_in` is true if it equals none of them. When the value can't be
  resolved, the result is `unknown`, not `true`.
- **Lifecycle unchanged** (decision 2026-10-23):
  - Targeting is evaluated site-wide on first touch and cached (eligible /
    excluded cooldown), and is never re-gated for assigned visitors.
  - Exclusions are evaluated on every on-page pageview, assigned visitors
    included.
  - Only the predicate changes, not when it runs.
- The **`experiment` dimension** is allowed only in exclusion trees, not in
  targeting trees, for now. Validation enforces this in crobot, and the
  evaluator treats it as `unknown` in targeting.
- Engine call sites switch to the tree when it's present: `engine.ts`, the
  next/react `apply-assignments`, `cold-decision`, and the router-guard
  `use-cookie-assignment`.
- Tracing: `describeTargeting` gains a tree form that reports the first failing
  group and its condition results.

### A3. Collector (`apps/collector/src/config/build.ts`)

- For v2 experiments, emit `targeting_tree` / `exclusion_tree`:
  - **from groups** when crobot sends them;
  - **otherwise from the flat rules, exactly:**
    - targeting → `all[ any[rules of dimension d₁], any[rules of d₂], … ]`,
      which is today's grouping;
    - exclusions → `any[ any[all rules] ]`, which is today's flat OR.
- Keep the flat `targeting` / `exclusions` fields for v1 SDKs and pixels.
- Pass `mutex_groups` through, and `mutex_group_id` per experiment.

### A4. crobot

- Migration:
  - new table `experiment_rule_groups`: `id, experiment_id, type
    (targeting|exclusion), joiner (and|or), position, timestamps`;
  - `experiment_rules.group_id` (nullable FK);
  - `experiments.targeting_joiner` and `experiments.exclusion_joiner` (default
    `and` and `or`).
- **Existing data is not rewritten.** v2 experiments without groups are
  converted to groups the first time they're edited:
  - targeting → one OR group per dimension, top-level AND;
  - exclusions → **one OR group** holding all rules.
  This preserves behaviour exactly.
- API: experiment create/update accepts
  `targeting: { joiner, groups: [{ joiner, rules: [...] }] }`, and the same for
  `exclusions`. v1 keeps the flat payload, and sending groups for v1 → 422.
- Validation:
  - no empty groups;
  - every operator must be valid for its dimension;
  - `values` only with `in`/`not_in` (1–100 items);
  - `experiment` dimension only in exclusions;
  - backstop of **200 conditions per experiment** across both sections.
    Customers run many cookie exclusions, so there's no small per-group cap.
- The config payload sent to the collector carries the groups.

### A5. Pixel

Today the pixel only evaluates the 4.0 `audience` tree, and `rules/legacy.ts`
isn't wired in, so v2 pixel projects may currently ignore
`targeting[]`/`exclusions[]` altogether (**verify first**; it's a bug either
way). The pixel imports the experiment-core evaluator, so there's one
implementation for every surface.

### B1. Evaluation (`experiment-core` `engine.ts`, before the existing gates)

```
for experiment in visitor order:
  if experiment.mutex_group_id:
    if cookie holds experiment assigned              → continue to gates (cookie-first)
    if cookie holds ANOTHER group member assigned    → skip   reason: mutex_taken
    slot = xxhash32(visitor:group:mx) % 10000
    if slot ∉ experiment's range                     → skip   reason: mutex_slot
  a. targeting  b. page rule  c. exclusions  d. assign      — unchanged
```

- **No new cookie state.** The slot can be recomputed from the visitor id, like
  traffic allocation.
- The group hash key (`visitor:group:mx`) is independent of the bucketing key
  (`visitor:experiment`), so the variation split inside a slice stays unbiased.
- `mutex_taken` keeps edits safe: someone already in Exp 12 is never enrolled in
  Exp 15, even if Exp 12's range later shrinks and their slot now belongs to
  Exp 15.
- Visitor order stops mattering within a group. It still applies to experiments
  outside groups.
- **Fixed slots, no "first reached wins" or eligible-only re-split.** A visitor
  whose slot belongs to an experiment they never reach (another page, failed
  targeting) is in no group experiment. That's stable and unbiased; the cost is
  traffic. A first-come mode skews funnel experiments and is out of scope.
- The pixel's existing string `mutex_group` (`traffic.ts`) is replaced by this
  for v2.

### B2. crobot

- Tables:
  - `experiment_groups`: `id, project_id, name, timestamps`;
  - `experiment_group_slots`: `group_id, experiment_id (UNIQUE → one group per
    experiment), range_start, range_end`.
- Validation:
  - ranges can't overlap and must fit within 0–9999;
  - v2 experiments only;
  - all members belong to the group's project.
- **Allocation algorithm.** The UI edits percentages; crobot maps them to ranges:
  - keep each member's `range_start`, grow or shrink at the end;
  - take new space from free slots;
  - never renumber the whole group, because that would move visitors between
    experiments.
  If a growth can't fit contiguously, crobot allocates the next free contiguous
  range. A member then owns several ranges, so the wire format is a list of
  slot entries per experiment, not one entry.
- Removing or finishing a member keeps its range **reserved** until an admin
  explicitly releases it.
- The UI shows the share, the holdout %, and an **expected enrolled per week**
  per member. The estimate is recent page_view reach × targeting pass ×
  traffic_allocation × share, from the collector's raw events.
- The UI warns when a running member's share changes. It doesn't affect the
  variant split (no SRM), only how many new visitors enter.
- Group creation hint: "Use for experiments on the same page or funnel. If they
  share a control, consider one experiment with more variations."

### B3. Analytics

- Per-experiment results are unchanged: only enrolled visitors count, and a
  visitor whose slot belongs to another member isn't counted as this
  experiment's control.
- Group-level holdout reporting is a follow-up, not part of this PRD.

## Testing Decisions

- **Parity (tests first):** for randomized flat rule sets, a tree built from
  flat rules ≡ `passesTargeting` / `isExcludedByRules` (property test, including
  unsupported dimensions).
- **Kleene table:** exhaustive unit tests of AND/OR × T/F/U and of the final
  mapping for each section.
- **Story cases:** `country not_in [A,B]`; `country ≠ A AND country ≠ B` in an
  AND group; OR-of-groups; exclusion "all of" group; no geo signal → targeting
  fails / exclusion doesn't fire.
- **Mutex distribution:** over 100 k synthetic visitor ids, each member's share
  is within ±0.5 pp of its range share; inside each member the variant split
  passes SRM; slot is the same across `runExperiments` calls and pages.
- **Mutex edits:** a visitor assigned to A, A's range shrunk → still A, never B
  (`mutex_taken`); a new visitor in the moved slots → B.
- **Collector:** `build.ts` emits trees from groups and from flat rules (golden
  configs), keeps the flat fields, and passes `mutex_groups` through.
- **crobot:** feature tests for the API shapes, validation (422s), the
  lazy group conversion, and allocation (no renumbering, fragmented growth).
- **Live e2e on staging** (per the live-over-mocks rule):
  - geo `not_in` from two countries (VPN or `cfGeoData` override);
  - OR groups via UTM;
  - a three-experiment group across landing / product / checkout, checking
    shares in the collector and no visitor in two members.

## Rollout Slices

Each slice can ship on its own and is a separate task file once the design
lands.

1. **shared-types + experiment-core:** `evaluateRuleTree` (Kleene), `in`/`not_in`,
   and the parity suite.
2. **experiment-core mutex:** slot gate, `mutex_taken` / `mutex_slot` reasons,
   and the distribution tests.
3. **Collector `build.ts`:** trees (from groups or derived from flat rules) and
   mutex passthrough.
4. **SDK call sites + pixel unification,** then the `1.7.0-rc` prerelease and a
   staging e2e.
5. **crobot:** migrations, models, API, validation, allocation, config payload.
6. **Admin UI** (Mantas's design) on top of the slice 5 API, including the
   enrolled-per-week estimate.

## Out of Scope

- Nesting deeper than two levels; NOT groups.
- The `experiment` dimension in targeting.
- Re-gating assigned visitors when targeting changes.
- First-come / eligible-only mutex modes.
- An experiment in more than one mutex group.
- Group-level holdout reporting.
- Converting the 4.0 `audience` tree into these trees (separate decision;
  `audience` stays pixel-only as documented).

## Open Questions

1. Is the top-level joiner between groups selectable (AND/OR), or always AND?
2. "Lock" — Mantas's original note mentioned groups "where we lock certain…";
   meaning to be confirmed with the design (non-editable rules? pinned group?).
3. Show the unallocated range as an explicit "Holdout" in the UI?
4. Does the 200-condition backstop hold for the biggest current customers?
   Check the max of `experiment_rules` per experiment in prod.
