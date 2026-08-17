---
id: "N.11"
title: "HTML-experiment demo + Playwright e2e (no-flicker, sticky, multi-experiment)"
phase: "N"
status: pending
estimate_days: 1
blocked_by: ["N.10"]
files_to_create:
  - demo/next-split-url/app/dom-experiment/page.tsx
  - demo/next-split-url/e2e/html-experiment.spec.ts
files_to_modify:
  - demo/next-split-url/app/layout.tsx      # add <TestaShield/> + <TestaExperiments/>
  - demo/next-split-url/testa.config.ts     # add a DOM (css/text) experiment
references:
  - packages/next/src/experiments/index.ts
  - tasks/phase-P/P.5-playwright-e2e.md
commits: []
completed_at: null
---

## Goal

Prove the HTML-experiment path end-to-end in a real browser: a variant-bucketed
visitor sees the DOM change with **no control flash**, the assignment is sticky
across reloads, and multiple DOM experiments co-apply. Deferred from N.10 (unit
tests cover the logic; this covers the render + shield timing empirically).

## Acceptance criteria

- The demo layout mounts `<TestaShield/>` (head) + `<TestaExperiments config/>`,
  and `testa.config.ts` has a DOM experiment (e.g. css color + text swap on a
  target element).
- Playwright asserts, for a variant-bucketed visitor:
  - the control text/style is **never painted** (assert the shield hid content
    until the variant applied — e.g. the element is only ever observed in its
    variant state, or the pre-reveal frame shows it hidden).
  - the variant is applied (text/style match the variant).
  - sticky: reload → same variant, no re-flash.
  - a control-bucketed visitor sees control, untouched.
- Runs headless in CI green (align with P.5 harness).

## Implementation notes

- Force a deterministic bucket (seed `_testa_uuid`, or set `_testa_exp`) so the
  variant path is stable.
- No-flicker detection: the shield hides `body` (opacity:0) until
  `window.__testa_shield.reveal()`; assert the target never renders in the
  control state before reveal (e.g. sample computed style / text at first paint).

## Out of scope

- Split-URL no-flicker e2e (that's P.5).
- Soft-nav re-apply flicker (v1 shields initial load; soft-nav re-applies
  without a shield — document as a known limitation, revisit if needed).
