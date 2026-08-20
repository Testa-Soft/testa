---
id: "P.6"
title: "Live-traffic cookie migration — 3.x per-experiment → packed _testa_exp"
phase: "P"
status: pending
estimate_days: 0.5
blocked_by: []
files_to_create:
  - docs/reference/cookie-migration.md
references:
  - packages/experiment-core/src/packed-cookie.ts
  - apps/pixel/src/runtime/cookies.ts
  - decision_experiment_storage_model (memory)
commits: []
completed_at: null
---

## Goal

Decide + document how existing 3.x visitors carry over when the v2 pixel/middleware
(packed `_testa_exp`) go live, so nobody silently re-buckets mid-experiment.

## Context

v2 (pixel + middleware) uses ONE packed `_testa_exp` cookie. Legacy 3.x used
per-experiment `_testa_exp_<id>` = variation identifier. A v2 host does NOT read
the old cookies, so a returning 3.x visitor with no packed cookie **re-buckets**
once. Bucketing is deterministic on `_testa_uuid`, so they usually land in the
same variation — but not guaranteed if weights/traffic changed since. For a fresh
rollout this is a non-issue; for cutover on live experiments it matters (SRM /
consistency).

## Acceptance criteria

- [ ] Decision recorded: (a) accept one-time re-bucket (deterministic ≈ same), or
      (b) a one-time read-old-write-packed shim in the pixel/middleware that seeds
      the packed cookie from any `_testa_exp_<id>` on first v2 load.
- [ ] If (b): implement + test the shim (read legacy per-exp cookies → seed packed
      entry → done once). Keep it behind a flag; remove after the rollout window.
- [ ] Rollout note: fresh projects skip this; migrating projects follow the doc.
