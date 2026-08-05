---
id: "N.1"
title: Extract packages/experiment-core — host-agnostic decision core behind CookieStore
phase: "N"
status: in_progress
estimate_days: 2
blocked_by: []
files_to_create:
  - packages/experiment-core/src/index.ts
  - packages/experiment-core/src/cookie-store.ts
  - packages/experiment-core/src/xxhash.ts
  - packages/experiment-core/src/assign.ts
  - packages/experiment-core/src/redirect/index.ts
  - packages/experiment-core/src/redirect/match.ts
  - packages/experiment-core/src/redirect/build-url.ts
  - packages/experiment-core/src/redirect/merge-params.ts
  - packages/experiment-core/src/redirect/dedup.ts
  - packages/experiment-core/src/store/exp-codec.ts
  - packages/experiment-core/src/__tests__/parity.test.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - apps/pixel/src/runtime/redirect/index.ts
  - apps/pixel/src/runtime/experiments/traffic.ts
  - tasks/phase-3/3.16-storage-consolidation.md
commits: []
completed_at: null
---

## Goal

Extract the pure, host-agnostic **decision core** out of `apps/pixel/src/runtime`
into a new shared package `packages/experiment-core`: the `xxhash32` bucketing,
the `assign()` traffic-allocation logic, the `redirect/*` matchers
(match/build/merge-params/dedup), and the packed `_testa_exp` cookie codec (task
3.16) — all parametrized over a `CookieStore` interface so the same
implementation runs unchanged in the Next.js Edge Runtime, in Node, and in the
browser. Refactor the pixel to consume the extracted package; the existing pixel
test suite is the parity gate (zero behaviour change).

## Context

Today the redirect decision lives in the pixel (`apps/pixel/src/runtime/redirect/index.ts`)
and reads/writes `document.cookie` directly, so the middleware and the pixel
would each need their own copy of bucketing + redirect logic — and any drift
between them flips visitors mid-test (SRM break, the highest risk in the PRD).

The fix is **one decision core, host-agnostic** (PRD "One decision core"):

- `xxhash32` is pure TS (`TextEncoder` + `Math.imul`, no Node crypto) so it runs
  in the Edge Runtime and Node unchanged. Bucketing stays
  `xxhash32(visitor_id:experiment_id) mod 100` with the **same frozen
  `SEED = 0xabcdef`** as the pixel — never `Math.random()`.
- The DOM coupling is removed behind a `CookieStore` seam:

  ```ts
  interface CookieStore {
    get(name: string): string | null
    set(name: string, value: string, opts: { maxAgeSec: number }): void
  }
  ```

  The middleware supplies a store reading `req.cookies` / writing onto the
  `NextResponse`; the future pixel supplies its existing `document.cookie` store.
  Same `assign()` and same redirect matchers run in both — no drift is
  structurally possible.
- The packed `_testa_exp` codec (task 3.16 layout:
  `expId.variation.excluded.sessionExp` joined by `~`) moves into the core so the
  middleware can own the cookie contract in v1 without waiting for the pixel.

This is the one real risk item in the PRD (N.1); N.2–N.5 are mechanical once the
core is shared. Implementation has already begun on `packages/experiment-core`.

## Acceptance criteria

- New package `packages/experiment-core` builds independently and exports:
  `xxhash32`, `assign()`, the `redirect/*` matchers, the `_testa_exp` codec, and
  the `CookieStore` interface.
- `CookieStore` is the only I/O seam — the core never touches `document`,
  `window`, `req`, or `NextResponse` directly.
- `xxhash32` uses `SEED = 0xabcdef` and produces byte-identical buckets to the
  current pixel implementation (assert against captured pixel vectors).
- The pixel is refactored to consume `experiment-core` via a `document.cookie`
  `CookieStore` adapter; no bucketing/redirect logic remains duplicated in
  `apps/pixel/src/runtime`.
- The existing pixel test suite passes unchanged — it is the parity gate. Zero
  observable behaviour change in the pixel.
- The `_testa_exp` codec matches the 3.16 format exactly (URL-unreserved chars
  only, no base64, immutable read/write/upsert).
- Package targets both Edge Runtime and Node (no Node-only APIs; verified by a
  build/import smoke test).

## Implementation notes

- Keep files small and single-purpose (mirror the pixel's `redirect/` split:
  `match.ts`, `build-url.ts`, `merge-params.ts`, `dedup.ts`).
- Port `redirect/dedup.ts` semantics as-is — it becomes the
  `_testa_redirected_<expId>` guard the middleware reuses.
- The codec is shared with 3.16; if 3.16's `store.ts` lands first, move its logic
  here rather than duplicating.
- Do not add analytics, consent, audience, frequency-cap, or mutex logic to the
  extraction — split-URL redirect + assign + codec only.

## Tests

- Bucketing parity vectors: fixed `(visitor_id, experiment_id)` pairs → expected
  bucket, byte-identical to pixel.
- `assign()` allocation + exclusion round-trips through a fake `CookieStore`.
- Redirect match/build/merge-params/dedup unit tests ported from the pixel.
- Codec round-trip + malformed-value fail-open (mirror 3.16).
- Edge/Node import smoke test (no Node-only globals).

## Out of scope

- The Next.js middleware, `NextCookieStore`, and `_testa_uuid` minting — see N.2.
- Config distribution — see N.3.
- Any DOM-mutation, analytics, or consent logic.
