---
id: "P.6"
title: "Live-traffic cookie migration — 3.x per-experiment → packed _testa_exp"
phase: "P"
status: done
estimate_days: 0.5
blocked_by: []
files_to_create: []
references:
  - packages/experiment-core/src/legacy-migration.ts
  - packages/experiment-core/src/packed-cookie.ts
  - apps/pixel/src/runtime/cookies.ts
  - decision_experiment_storage_model (memory)
commits: []
completed_at: 2026-09-04
---

## Goal

Decide + document how existing 3.x visitors carry over when the v2 pixel/middleware
(packed `_testa_exp`) go live, so nobody silently re-buckets mid-experiment.

## Context

v2 (pixel + middleware) uses ONE packed `_testa_exp` cookie. Legacy 3.x used
per-experiment `_testa_exp_<id>` = variation identifier. A v2 host does NOT read
the old cookies, so a returning 3.x visitor with no packed cookie **re-buckets**
once.

The original write-up assumed the re-bucket was "usually the same variation
because bucketing is deterministic on `_testa_uuid`". That is wrong for 3.x:
`integration/3.6/script.js` allocates with `Math.random()`, so the re-roll is
uncorrelated with the original — about half of all returning visitors flip
variation. For a live cutover that is contamination of both arms, not a rounding
error. Option (b) was therefore the only viable choice.

## Outcome — option (b), shipped

Read-old-write-packed shim, opt-in per host via `legacyCookiesEnabled`.

The migration turned out to be a pure repack: the collector maps
`experiment_id: e.identifier` / `variation_id: v.identifier`
(`apps/collector/src/config/build.ts`), which are the SAME crobot integers the
legacy cookie names and values carry. No id mapping, no lookup, no network call.

## Acceptance criteria

- [x] Decision recorded: (b) — a read-old-write-packed shim seeding the packed
      cookie from any `_testa_exp_<id>` / `_testa_excl_<id>` / `_testa_ses_<id>`.
- [x] Implemented + tested: `packages/experiment-core/src/legacy-migration.ts`
      (17 unit tests) plus the middleware seam
      (`packages/next/src/__tests__/legacy-cutover.test.ts`, 6 tests).
- [x] Behind a flag: `createTestaProxy({ legacyCookiesEnabled })` and
      `<TestaProvider legacyCookiesEnabled />`. Customer-owned, no backend field.
- [x] Rollout note: `legacyCookiesEnabled` in the `createTestaProxy` /
      `<TestaProvider>` option tables (`docs/integrations/nextjs.md`). Fresh
      projects skip it. Cutover instructions are given to customers directly.

## Notes for removal

Deliberately NOT time-boxed by a date — customers cut over whenever they choose,
so a calendar cutoff would strand a later migration. It self-terminates two ways
instead: per-visitor (skip once a packed entry exists) and per-experiment (only
experiments in the current config are probed, so it goes inert when the legacy
tests end). `debug: true` reports `legacyMigrated: [ids]` when a request adopts
something — that going quiet is the signal to drop the flag and delete the code.
