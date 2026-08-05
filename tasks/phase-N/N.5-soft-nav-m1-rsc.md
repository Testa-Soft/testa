---
id: "N.5"
title: "Soft-nav M1 — middleware handles App-Router RSC navigation (prefetch-safe)"
phase: "N"
status: done
estimate_days: 1.5
blocked_by: ["N.4"]
files_to_create:
  - packages/next/src/soft-nav/rsc-redirect.ts
  - packages/next/src/soft-nav/prefetch-guard.ts
  - packages/next/src/soft-nav/__tests__/rsc-redirect.test.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/next/src/redirect-loop.ts
commits: []
completed_at: 2026-08-05
---

## Goal

Extend the middleware to cover **App-Router RSC soft navigations** — the universal
safety net (M1) — so a split-URL redirect fires flash-free on client-side `<Link>`
transitions, not just initial/hard loads. Spike first to validate the RSC-redirect
mechanics, then handle the prefetch trap so assignment side effects never fire for
links nobody clicked.

## Context

Split-URL redirects must also work on client-side SPA navigation, not just
initial/hard loads (user requirement). v1 covers soft nav with two mechanisms —
M1 here and M2 in N.6 — both reading the *same* sticky `_testa_exp` cookie +
`experiment-core`, so a visitor gets the same variant no matter which fires.

**M1 — middleware, the universal safety net (primary in v1):** on an App-Router
`<Link>` transition the client fetches the destination's **RSC payload** from the
server, and middleware runs on that request. Redirecting it makes the client
router follow to the variant; control RSC is never returned → **no flash**. Always
works, requires no dev changes. Covers initial/hard loads (already the core flow)
**and** App-Router RSC soft navs.

**Prefetch trap (must handle):** App Router prefetches `<Link>` targets (RSC
requests carrying `Next-Router-Prefetch: 1`) on hover/viewport, and these also hit
the middleware. We must **not** persist committing state on a prefetch — no
`_testa_redirected` cookie, no `Set-Cookie`, no (future) exposure — or assignment
side effects fire for links nobody clicked. Rule: on a prefetch request,
**compute but do not commit**.

**Spike first:** the RSC-redirect mechanics (redirecting an RSC request so the
client router follows) are the sharp edge flagged in N.4 (O-N.4). Validate them in
a spike before finalizing; the outcome may narrow the documented boundary.

## Acceptance criteria

- The middleware detects App-Router RSC navigation requests and applies the same
  N.4 decision loop so a bucketed variant redirect follows client-side with **no
  control paint**.
- **Prefetch-safe:** on a request carrying `Next-Router-Prefetch: 1`, the
  middleware **computes but does not commit** — no `_testa_redirected` cookie, no
  `Set-Cookie`, no persisted assignment side effect.
- A committed (non-prefetch) RSC navigation redirects to the variant and persists
  cookies exactly as a hard load would.
- RSC and hard-load paths share the N.4 decision loop (one implementation).
- Spike documented: whether RSC-redirect works generally or the boundary is
  narrowed (e.g. hard-nav-only for certain cases).

## Implementation notes

- Detect RSC requests via the Next.js RSC request headers; treat prefetch strictly
  by the `Next-Router-Prefetch` header.
- Factor "compute" (assign + match, pure) from "commit" (cookie writes /
  markRedirected) so prefetch can run compute and skip commit cleanly.
- Do not re-fetch config or re-bucket differently for RSC vs hard load — same
  sticky `_testa_exp` and same core.

## Tests

- RSC navigation (non-prefetch), bucketed to variant + URL match → redirect +
  cookies committed.
- RSC prefetch request → decision computed, **no** `Set-Cookie`, no
  `_testa_redirected`.
- RSC and hard-load produce the same variant for the same visitor.

## Out of scope

- Pages-Router-static soft nav → covered by M2, see N.6.
- `<TestaLink>` (rewrite href at source) — deferred fast-follow.
- Analytics / exposure emission — deferred in v1.
