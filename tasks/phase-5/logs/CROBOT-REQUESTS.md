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
