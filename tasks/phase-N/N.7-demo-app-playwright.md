---
id: "N.7"
title: "Example Next.js app (App + Pages router) + Playwright no-control-paint assertions"
phase: "N"
status: pending
estimate_days: 1.5
blocked_by: ["N.5", "N.6"]
files_to_create:
  - demo/next-app/app/middleware.ts
  - demo/next-app/app/layout.tsx
  - demo/next-app/pages/index.tsx
  - demo/next-app/testa.config.ts
  - demo/next-app/e2e/no-control-paint.spec.ts
  - demo/next-app/playwright.config.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/next/src/create-middleware.ts
commits: []
completed_at: null
---

## Goal

Build an example Next.js app in `demo/` exercising both the App Router and the
Pages Router, wired to `@testa/next`, with Playwright assertions that prove **no
control paint** on both initial/hard load AND soft navigation. This is the
end-to-end proof that the flicker-free guarantee holds across every covered path.

## Context

The whole point of the middleware over the pixel is zero flicker: the 307 precedes
any HTML, so control is never painted. The demo must prove this empirically across
the paths v1 covers:

- **Initial / hard load** — 307 before HTML (M1 core flow, N.4).
- **App-Router RSC soft nav** — middleware redirects the RSC request, control RSC
  never returned (M1, N.5).
- **Pages-Router-static soft nav** — `<TestaRouterGuard/>` aborts in
  `routeChangeStart` before control renders (M2, N.6).

So the demo needs **both routers** wired to the same `@testa/next` integration and
a Playwright suite that fails if control ever paints for a variant-bucketed
visitor. This exercises the full stack: `experiment-core` bucketing, the config
client, the redirect loop, and both soft-nav mechanisms.

## Acceptance criteria

- `demo/` contains a runnable Next.js app with **both** an App-Router surface and
  a Pages-Router surface, wired via `createTestaMiddleware()` + (for Pages)
  `<TestaRouterGuard/>`.
- A split-URL experiment config (control `/a`, variant `/b`) drives the demo (from
  a local config fixture / config client).
- Playwright assertions prove **no control paint** for a variant-bucketed visitor
  on: initial/hard load, App-Router soft nav, Pages-Router-static soft nav.
- A control-bucketed visitor stays on control (negative case) and the variant is
  sticky across reloads (deterministic bucketing).
- The suite runs in CI headless and is green.

## Implementation notes

- Detect "control painted" robustly — e.g. assert the control route's marker
  element never becomes visible / never fires its paint, and/or assert the network
  timeline shows the 307 before any control document/RSC body.
- Seed a fixed `_testa_uuid` (or force a bucket) so the variant path is
  deterministic in the test.
- Keep the demo config local (fixture) so the demo does not depend on N.8's crobot
  publish side.

## Tests

- Hard load → variant, control never painted.
- App-Router `<Link>` soft nav → variant, control RSC never returned.
- Pages-Router-static soft nav → variant via router-guard, control never rendered.
- Control-bucketed visitor stays on control.
- Variant sticky across reloads.

## Out of scope

- crobot publish side — see N.8.
- `<TestaLink>` demo — deferred fast-follow.
- Analytics / consent flows.
