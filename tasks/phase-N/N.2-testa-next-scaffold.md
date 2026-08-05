---
id: "N.2"
title: "@testa/next scaffold — createTestaMiddleware, NextCookieStore, _testa_uuid minting"
phase: "N"
status: in_progress
estimate_days: 1
blocked_by: ["N.1"]
files_to_create:
  - packages/next/package.json
  - packages/next/src/index.ts
  - packages/next/src/create-middleware.ts
  - packages/next/src/next-cookie-store.ts
  - packages/next/src/uuid.ts
  - packages/next/src/__tests__/next-cookie-store.test.ts
  - packages/next/src/__tests__/uuid.test.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/experiment-core/src/cookie-store.ts
commits: []
completed_at: null
---

## Goal

Scaffold the publishable npm package `@testa/next`: the `createTestaMiddleware()`
factory, a `NextCookieStore` adapter implementing `experiment-core`'s
`CookieStore` over `req.cookies` / `NextResponse`, and first-party `_testa_uuid`
minting. This is the wiring shell — the redirect decision loop and config client
land in later tasks; here the middleware just mints/reads the visitor id and
returns `NextResponse.next()`.

## Context

`@testa/next` is the **whole v1 integration** (PRD "What this is"): the customer
wires it into `middleware.ts` in one place:

```ts
import { createTestaMiddleware } from '@testa/next'
export const middleware = createTestaMiddleware({ projectSlug: 'acme' })
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'] }
```

Two seams from N.1 must be satisfied here:

- **`NextCookieStore`** implements `CookieStore` — `get()` reads `req.cookies`,
  `set()` writes `Set-Cookie` onto the `NextResponse` the middleware returns. This
  is the adapter that lets the shared core run in the Edge Runtime.
- **First-party `_testa_uuid` minting** (PRD "Visitor id is first-party"): in a
  Next.js deployment the customer's origin serves the page, so the middleware is
  first-party and mints `_testa_uuid` itself — `HttpOnly`, `SameSite=Lax`, long
  `Max-Age` (~400d). On the first request the middleware mints the id and (later
  tasks) buckets with it in the same pass. This is more ITP-durable than the
  edge-worker cookie we have today, and the edge worker is no longer in the path.

The middleware runs on the **Edge Runtime** (the CF edge worker isn't in the Next
request path); the core is Node-compatible too. Implementation has already begun
on `packages/next`.

## Acceptance criteria

- `@testa/next` package builds and publishes (package.json with proper
  `exports`, peer dep on `next`, dep on `@testa/experiment-core`).
- `createTestaMiddleware({ projectSlug })` returns an async
  `(req) => NextResponse` handler.
- `NextCookieStore` implements `experiment-core`'s `CookieStore`: `get` reads
  `req.cookies`; `set` writes `Set-Cookie` onto the returned `NextResponse` with
  the given `maxAgeSec`.
- On a request with no `_testa_uuid`, the middleware mints one (`HttpOnly`,
  `SameSite=Lax`, `Max-Age` ~400d) and sets it on the response; on a request that
  already has one, it reuses it and does not re-mint.
- The scaffold middleware returns `NextResponse.next()` (no redirect yet) with the
  minted uuid cookie preserved.
- Runs under the Next.js Edge Runtime (no Node-only APIs in the middleware path).

## Implementation notes

- `mintUuid(store)` writes through the `CookieStore` seam so the same minting path
  works in tests with a fake store.
- Keep `create-middleware.ts` thin — it composes the store, uuid, (later) config
  client, and (later) decision loop. Later tasks slot into this shell.
- Do not read config or issue redirects here; those are N.3 / N.4.

## Tests

- `NextCookieStore.get` reads from `req.cookies`; `set` appends the expected
  `Set-Cookie` to the response.
- uuid minting: absent → minted once with correct flags; present → reused, not
  re-minted.
- Middleware returns `NextResponse.next()` and carries the uuid cookie.

## Out of scope

- `ConfigClient` / CDN fetch — see N.3.
- Redirect decision loop — see N.4.
- Soft-nav handling — see N.5 / N.6.
