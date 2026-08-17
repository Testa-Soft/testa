---
id: "N.10"
title: "HTML/DOM experiments in @testa/next — <TestaExperiments/> + <TestaShield/>"
phase: "N"
status: done
estimate_days: 1
blocked_by: ["N.4", "N.9"]
files_to_create:
  - packages/next/src/experiments/apply-assignments.ts
  - packages/next/src/experiments/TestaExperiments.tsx
  - packages/next/src/experiments/TestaShield.tsx
  - packages/next/src/experiments/index.ts
  - packages/next/src/experiments/__tests__/apply-assignments.test.ts
  - packages/next/src/client-cookie.ts
files_to_modify:
  - packages/next/src/engine.ts            # assign DOM experiments, not just redirects
  - packages/next/src/router-guard/TestaRouterGuard.tsx  # share readClientCookie
  - packages/next/package.json             # @testa-platform/dom, happy-dom, ./experiments export
  - packages/next/tsup.config.ts           # experiments entry
  - packages/next/tsconfig.json            # DOM.Iterable
references:
  - packages/dom/src/index.ts
  - docs/prds/003-nextjs-redirect-middleware.md
commits: []
completed_at: 2026-08-17
---

## Goal

Add HTML/DOM experiments (css/html/text/attr/js/hide/insert/move) to the plugin.
DOM changes can't run in the middleware (no server DOM), so the middleware
ASSIGNS them (deterministic, server-side, sticky `_testa_exp`) and a client
component RENDERS them cookie-first, with an anti-flicker shield.

## Acceptance criteria

- Engine assigns BOTH split-URL and DOM experiments in one pass: always buckets +
  writes the cookie; redirects only when the assigned variation has a redirect
  change. DOM-only experiments accumulate (several can apply per page). Existing
  split-URL tests unaffected.
- `resolveAssignedExperiments(config, cookie)` — cookie-first: returns the
  assigned variant's non-redirect changes per experiment (skips excluded/paused/
  control/redirect-only). `applyAssignedExperiments` wires them into
  `@testa-platform/dom#applyVariation` and returns teardowns.
- `<TestaExperiments config/>` — client component: applies on mount + re-applies
  on App-Router navigation (usePathname), disposes teardowns on cleanup, then
  reveals the shield. `<TestaShield/>` — inline `<head>` script (pre-paint hide,
  timeout fallback).
- Exported at `@testa/next/experiments`; the middleware (`.`) bundle stays
  react-free and apply-engine-free (verified in the built bundle).

## Tests

- Engine: a DOM-only experiment is assigned + cookie written, no redirect;
  sticky across visits.
- `resolveAssignedExperiments`: variant changes returned; control/none/excluded/
  paused → empty; redirect changes filtered out.
- `applyAssignedExperiments`: cookie → DOM actually mutated (happy-dom);
  `revealShield` calls `window.__testa_shield.reveal`.

## Out of scope

- Browser e2e / no-flicker demo → N.11.
- `audience`-tree targeting for DOM experiments (flat targeting only, as split-URL).
- Server-side HTML response transform (true zero-flicker) — future upgrade.
