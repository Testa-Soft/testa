---
id: "P.4"
title: "Server-side page_view goal conversions in the middleware"
phase: "P"
status: pending
estimate_days: 1
blocked_by: []
files_to_create:
  - packages/next/src/conversions.ts
  - packages/next/src/__tests__/conversions.test.ts
references:
  - packages/next/src/tracking.ts
  - reference_legacy_tracking_pipeline (memory)
  - packages/shared-types/src/project-config.ts
commits: []
completed_at: null
---

## Goal

Fire `page_view`-goal conversions server-side from the middleware, completing the
server-observable half of split_url analytics (exposure is already done in
`tracking.ts`).

## Context

Exposure (impression → `/api/leads`) is live. Conversions (`/api/leads/convert`,
payload `{goal_id, action, lead_uuid, variation, data}`) split by goal type
(see reference_legacy_tracking_pipeline):
- **page_view** — URL match; the middleware CAN do this server-side: for each
  active experiment the visitor is IN, on a request whose URL matches a
  page_view goal's `action` under its `match_type`, POST a convert.
- **click / custom** — inherently client-side → the co-shipped v2 pixel owns them.

Constraints:
- The config currently drops `goals: []` in the adapter — restore goal mapping
  (goal_id, type, action, match_type) in `apps/collector/src/config/build.ts`.
- crobot's convert REQUIRES a pre-existing exposure lead for `(uuid, experiment)`
  and dedups on `(lead_id, goal_id)`. So convert only for enrolled visitors; the
  5s server delay covers ordering.
- Reuse the `matchesForMode` from experiment-core for the URL match.

## Acceptance criteria

- [ ] Adapter maps `goals` into the served ProjectConfig (page_view goals at least).
- [ ] Middleware POSTs `/api/leads/convert` for a page_view goal URL match on an
      enrolled visitor, via `event.waitUntil`, deduped/idempotent, fire-and-forget.
- [ ] Not fired for excluded / not-enrolled visitors, or off the goal URL.
- [ ] Unit tests for the match + payload; documented that click/custom = the pixel.
