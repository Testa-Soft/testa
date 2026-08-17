---
id: "N.9"
title: "Extract packages/dom (apply engine) + anti-flicker shield"
phase: "N"
status: done
estimate_days: 0.5
blocked_by: ["N.1"]
files_to_create:
  - packages/dom/package.json
  - packages/dom/tsconfig.json
  - packages/dom/vitest.config.ts
  - packages/dom/src/index.ts
  - packages/dom/src/shield/shield.ts
  - packages/dom/src/shield/__tests__/shield.test.ts
files_to_modify:
  - apps/pixel/src/runtime/lifecycle.ts   # import applyVariation from @testa-platform/dom
  - apps/pixel/package.json               # add @testa-platform/dom
references:
  - packages/experiment-core/src/index.ts
commits: []
completed_at: 2026-08-17
---

## Goal

Hoist the pixel's DOM variation-apply engine (css/html/text/attr/js/hide/
insert/move) into a shared `@testa-platform/dom` package — the browser render
layer, paired with `experiment-core` (the host-neutral decision layer) — and add
an anti-flicker shield. Shared by the pixel, `@testa/next`, and any future client
SDK, so every surface applies variations identically.

## Context

The apply engine was already 3.3.3-parity and cleanly factored in the pixel
(`runtime/experiments/apply/`), depending only on `shared-types` + the DOM, with
`lifecycle.ts` its sole caller. Late-rendered elements are handled by a
MutationObserver with a timeout fallback (no polling — the "less workarounds"
version of 3.3.3's `setTimeout` retry loop).

## Acceptance criteria

- `apps/pixel/src/runtime/experiments/apply/**` moved to `packages/dom/src/apply/**`
  (git-tracked move; history preserved). Pixel imports `applyVariation` from
  `@testa-platform/dom`; pixel tests stay green.
- New `raiseShield()` / `buildShieldSnippet()` (+ `Shield`/`ShieldOptions`):
  hide content until reveal with a hard timeout fallback so a failed apply never
  leaves the page blank. `opacity:0` default (keeps layout). `buildShieldSnippet`
  emits an inlinable `<head>` IIFE that parks `reveal` on `window.__testa_shield`.
- Package builds host-neutral of any framework; `happy-dom` test env; coverage
  gate (80/75) green.

## Tests

- The moved apply suite (40 tests) passes under the new package.
- Shield: injects hiding style; `reveal()` removes it (idempotent); timeout
  auto-reveals; explicit reveal cancels the timeout; double-raise reuses one
  style; snippet evaluates + exposes `reveal`; selector/id safely encoded.

## Out of scope

- The Next client component / middleware wiring → N.10.
- A Vite/Lovable client SDK → later (reuses this package).
