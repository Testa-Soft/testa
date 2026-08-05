---
id: "N.6"
title: "Soft-nav M2 — <TestaRouterGuard/> client component (Pages-Router-static catch-all)"
phase: "N"
status: done
estimate_days: 1
blocked_by: ["N.4"]
files_to_create:
  - packages/next/src/router-guard/TestaRouterGuard.tsx
  - packages/next/src/router-guard/use-cookie-assignment.ts
  - packages/next/src/router-guard/__tests__/TestaRouterGuard.test.tsx
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/experiment-core/src/index.ts
commits: []
completed_at: 2026-08-05
---

## Goal

Ship `<TestaRouterGuard/>`, the optional client-side catch-all interceptor (M2)
for soft navigations the middleware can't see — notably **Pages-Router-static**
soft nav, which never reaches the server. It reads the sticky assignment cookie
via `experiment-core` (no re-roll, no config re-fetch) and `router.replace()`s to
the variant on a control-URL match, aborting before the control page renders.

## Context

Middleware alone doesn't cover every soft nav: a Pages-Router soft nav to a fully
static page never hits the server, so M1 (N.5) can't see it. M2 is the
belt-and-suspenders catch-all. Both mechanisms live in the npm package ("Next.js
is the integration" holds; no external pixel), and both read the *same* sticky
`_testa_exp` cookie + `experiment-core`, so a visitor gets the same variant no
matter which fires. App-Router customers get flash-free soft nav from M1 alone; M2
covers Pages-Router-static and anything M1 misses.

**Mechanics (PRD "M2"):** a small client component added once in the layout. It
hooks router navigation events, reads the sticky cookie via `experiment-core` (no
re-roll, no config re-fetch), and on a control-URL match `router.replace()`s to
the variant — aborting in `routeChangeStart` before the control page renders to
avoid a one-frame flash.

Because it is **cookie-first** (the assignment already exists in `_testa_exp`, set
by the middleware on a prior request), it never re-buckets and never fetches
config — it only redistributes an assignment that already happened.

## Acceptance criteria

- `<TestaRouterGuard/>` is a client component added once in the layout; no other
  per-page dev work.
- It hooks Pages-Router navigation events (`routeChangeStart`) and reads the
  assignment from `_testa_exp` via `experiment-core` — **no re-roll, no config
  re-fetch**.
- On a navigation to a control URL for an experiment the visitor is assigned to a
  variant of, it aborts the in-flight navigation in `routeChangeStart` and
  `router.replace()`s to the variant **before the control page renders** (no
  one-frame flash).
- When there is no matching assignment / no control-URL match, it does nothing and
  navigation proceeds normally.
- Reads the same sticky cookie as the middleware — a visitor gets the same variant
  whether M1 or M2 fires.
- Adds no assignment side effects (does not write `_testa_exp` or re-bucket); it
  only acts on an assignment already present.

## Implementation notes

- Cookie-first only: if `_testa_exp` has no entry for the experiment, do nothing —
  M2 must never mint an assignment (that would risk drift with the server core).
- Abort as early as possible in `routeChangeStart` to beat the control render;
  use `router.events` (Pages Router).
- Keep the component tiny and dependency-light; reuse `experiment-core` for
  reading the packed cookie and redirect matching.

## Tests

- Assigned-to-variant + navigation to control URL → navigation aborted +
  `router.replace` to variant, no control render.
- No assignment / no match → navigation proceeds untouched.
- Variant chosen matches what the middleware would pick for the same cookie.

## Out of scope

- App-Router RSC soft nav → M1, see N.5.
- `<TestaLink>` (rewrite href at source) — deferred fast-follow.
- Any DOM-mutation experiment, analytics, or consent.
