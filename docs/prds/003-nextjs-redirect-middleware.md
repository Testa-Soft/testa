# PRD 003 — Next.js split-URL middleware (`@testa/next`)

**Status:** draft — scope locked, ready to break into tasks
**Owner:** unassigned
**Date:** 2026-08-04
**Origin:** design-doc request 2026-08-04. Un-parks the "Next.js middleware
redirect = separate later product" decision from
[[decision_v2_full_parity_port]]. Scope + open questions resolved with the user
in-thread (see _Design decisions_).

---

## Problem statement

Split-URL (redirect) experiments flicker. Today the redirect is **pixel-decided**
(`apps/pixel/src/runtime/redirect/index.ts`): the browser loads the original URL,
the pixel boots, buckets the visitor, then calls `location.replace()`. The
visitor sees the control page for one paint before being thrown to the variant —
a visible flash and a real conversion tax on exactly the axis where we must beat
VWO/ABTasty ([[scope_framing]], [[architecture_redirects_v1]]), and the root of
the known SPA redirect bug ([[known_pixel_spa_bug]]).

For customers on **Next.js**, a middleware runs on the server *before any HTML is
sent*, so a split-URL experiment becomes a `307` at the network layer. No control
paint, ever.

## What this is

A published npm package, **`@testa/next`**, wired into a customer's Next.js app
in one place:

```ts
// middleware.ts
import { createTestaMiddleware } from '@testa/next'
export const middleware = createTestaMiddleware({ projectSlug: 'acme' })
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'] }
```

That's the whole integration for v1. The middleware:
- reads the project's experiment config (CDN-published, propagates immediately),
- mints/reads a first-party visitor id,
- deterministically buckets the visitor into a variation,
- for **split-URL (redirect) experiments only**, issues a `307` to the variant
  URL server-side (zero flicker),
- persists a sticky assignment cookie so the decision is stable across visits.

**No client pixel, no analytics, no consent handling in v1.** Those come later
(see _Future direction_).

## Scope of THIS PRD

**In scope**

1. New package `@testa/next` — a `createTestaMiddleware()` factory for Next.js.
2. **Split-URL (redirect) experiments only**, decided server-side. Nothing else.
3. **Soft-navigation coverage** (user requirement) via two mechanisms in v1:
   middleware (App-Router RSC-request redirect — the universal safety net) and an
   optional `<TestaRouterGuard/>` (catch-all for Pages-Router-static).
   `<TestaLink>` is deferred (see _Future direction_). See _Soft-navigation
   coverage_.
4. Extraction of the pure **decision core** (`xxhash32` bucketing, traffic
   allocation, redirect match/build/dedup, the packed-cookie codec) out of
   `apps/pixel/src/runtime` into a shared, host-agnostic
   `packages/experiment-core` behind a `CookieStore` seam — so the middleware and
   the (future) pixel share ONE implementation and can never drift on bucketing.
5. First-party **visitor-id minting** in the middleware (ITP-durable).
6. A **CDN config-distribution** design that propagates config changes to the
   running Next app immediately.

**Explicitly OUT of scope (deferred)**

- Everything except split-URL redirects. No DOM-mutation experiments, no edge
  HTML rewriting, no client pixel injection in v1. (User, 2026-08-04.)
- **Analytics / exposure events.** v1 ships no tracking at all. (User.)
- **Consent handling.** Ignored in v1. (User.)
- The edge worker as part of the config or redirect path — it drops out. (User:
  "we'd be using nextjs as the integration … maybe the edge worker for config,
  but I doubt it.")
- Audience targeting, frequency cap, mutex group server-side (the core supports
  them; the split-URL slice doesn't need them yet).

**Future direction (named, not designed here)**

- **`<TestaLink>` — rewrite the destination at the source.** A `next/link`
  wrapper that runs the same `experiment-core` bucketing at render and rewrites
  `href` to the variant URL, so the click goes straight to `/b`: **no redirect,
  no flash, correct prefetch**. Resolves with no server round-trip (uuid cookie
  already set); a Server-Component variant resolves at SSR with zero client JS.
  The best-UX soft-nav path, but opt-in (only covers links routed through it), so
  it's a fast-follow enhancement on top of the v1 middleware safety net — not a
  v1 blocker. (Deferred per user, 2026-08-04.)
- **Feature flagging / HTML-via-code — a semi-dev solution.** The next addition
  is developer-facing: the middleware / a small server SDK resolves a visitor's
  assignment and exposes it to the customer's *own code* — e.g.
  `getVariant(req, experimentId)` or a flag on the request / an RSC boundary — so
  the developer branches their JSX or server logic on it. Flags **code the
  customer wrote**, not visual DOM edits. Reuses the same `experiment-core`
  assignment + cookie contract; only the surfacing is new.
- **Analytics.** When it lands: emit an `experiment_view` **before** the redirect
  (source page) and reconcile against any **post-redirect** exposure (destination
  page) using a **deterministic `event_id`** so the two collapse to one
  ([[architecture_event_dedup]]). (User confirmed the event_id approach.)
- **Client pixel** rejoins the moment a customer needs DOM experiments or
  tracking; at that point it reads the middleware-written cookie (see _Cookie
  contract_) and never re-rolls.

---

## Design decisions (locked)

### Split-URL uses a redirect, not a rewrite
The Vercel A/B pattern (referenced blog) uses `NextResponse.rewrite` to serve
different content under the *same* URL. That is the wrong semantic here: a
**split-URL test has two genuinely distinct URLs** (control `/a`, variant `/b`),
and the variant experience *is* the variant URL. So we `NextResponse.redirect(…,
307)`. It's flicker-free because the 307 precedes any HTML — strictly better than
the pixel's `location.replace()`, which paints control first. (Rewrite-style
same-URL variants belong to the future feature-flagging product, not here.)

### Deterministic bucketing, never `Math.random()`
The blog buckets with `Math.random()` against a threshold. We reject that — it
causes Sample Ratio Mismatch drift and breaks cross-device consistency
([[architecture_variation_bucketing]]). The middleware imports the **same**
`xxhash32(visitor_id:experiment_id) mod 100` and the **same frozen
`SEED = 0xabcdef`** as the pixel. On the first request the middleware mints the
visitor id and buckets with it in the same pass, then persists — deterministic
and sticky from request one.

### One decision core, host-agnostic
`xxhash32` is pure TS (`TextEncoder` + `Math.imul`, no Node crypto) → runs
unchanged in the Next.js Edge Runtime **and** Node. We extract it, the
`assign()` traffic logic, and the `redirect/*` matchers into
`packages/experiment-core`, parametrized over a `CookieStore` interface:

```ts
interface CookieStore {
  get(name: string): string | null
  set(name: string, value: string, opts: { maxAgeSec: number }): void
}
```

- Middleware supplies a store reading `req.cookies` and writing onto the
  `NextResponse` it returns.
- The future pixel supplies its existing `document.cookie` store.

Same `assign()` and same redirect matchers run in both. No drift is structurally
possible.

### The middleware owns the cookie contract (v1 unblocks 3.16)
Because there is **no pixel in v1**, the middleware is the sole reader/writer of
its cookies — so it can *define* the packed `_testa_exp` format
([[decision_experiment_storage_model]], task 3.16: `expId.variation.excluded.
sessionExp` joined by `~`) rather than wait for the pixel to adopt it first. The
pixel conforms later when it rejoins. **This removes 3.16 from the critical
path** — we build the codec in `experiment-core` and the middleware uses it now.

### Visitor id is first-party, middleware-minted
In a Next.js deployment the customer's origin serves the page, so the middleware
is first-party and mints `_testa_uuid` itself — `HttpOnly`, `SameSite=Lax`, long
`Max-Age`. This is **more** ITP-durable than the edge-worker-set cookie we have
today, and the edge worker is no longer in the path anyway.

### No consent, no tracking, no pixel in v1
All three deferred per user. The middleware's only side effects are: set
`_testa_uuid` (if absent), set the packed assignment cookie, and possibly a 307.

---

## Config distribution (the interesting part)

**Requirement (user):** experiment changes must propagate **immediately** — the
moment an admin edits config, the running Next app picks it up (on initial load),
without a redeploy. The intended mechanism is a **CDN-published hashed JSON**.

### Publish side (crobot)
On config save, crobot publishes two objects to a CDN:
- **Immutable config:** `…/projects/{slug}/{config_hash}.json` — the full
  `ProjectConfig`. Immutable ⇒ cacheable forever (`Cache-Control: immutable`).
- **Mutable pointer:** `…/projects/{slug}/current.json` → `{ "config_hash": "…",
  "published_at": "…" }`. Tiny, served with a very short TTL / purged on publish
  so it flips immediately.

This reuses the `config_hash` field that already exists on `ProjectConfig`.

### Read side (`@testa/next`)
Per request, on the hot path:
1. Read the pointer (`current.json`). Small; short TTL or Next fetch-cache with
   `revalidate: 0` so a config change is visible on the next request.
2. If its `config_hash` matches what's in the in-memory instance cache, use the
   cached immutable config (zero extra fetch).
3. On a new hash, fetch `{config_hash}.json` once, cache it immutably in-instance,
   revalidate the pointer in the background (`waitUntil`) to keep p99 flat.

Net: config changes are live on the **next request** (immediate propagation),
while steady-state adds at most one tiny pointer read that is itself cacheable.

> **Recommendation to evaluate (O2):** if the customer is on **Vercel**, prefer
> **Vercel Edge Config** over a CDN fetch — reads are ~0 ms (globally replicated,
> no per-request network hop) and writes propagate in seconds, which is *exactly*
> "immediate propagation" with none of the pointer-fetch latency. crobot writes
> config to Edge Config via the Vercel API on publish. The CDN-hashed-JSON path
> stays as the portable fallback for non-Vercel / self-hosted Next. Both hide
> behind the same `ConfigClient` interface, chosen by adapter.

---

## Cookie contract (v1, middleware-owned)

| Cookie | Written by | Semantics | TTL |
|---|---|---|---|
| `_testa_uuid` | middleware (first-party) | persistent visitor id, `HttpOnly` | long (e.g. 400d) |
| `_testa_exp` | middleware | packed positional assignment/exclusion/session per experiment (task 3.16 codec) | 30d |
| `_testa_redirected_<expId>` | middleware | once-per-experiment redirect dedup (mirrors `redirect/dedup.ts`) | session/short |

The future pixel reads all three; a valid `_testa_exp` entry makes it take the
cookie-first path and never re-bucket.

---

## Middleware request flow

```
createTestaMiddleware({ projectSlug }) → async (req):
  config    ← configClient.get(projectSlug)            # pointer + immutable, cached
  store     ← NextCookieStore(req)                     # reads req.cookies
  res       ← NextResponse.next()                      # store writes Set-Cookie onto res
  visitorId ← store.get('_testa_uuid') ?? mintUuid(store)   # first-party HttpOnly

  for exp of config.experiments where status === 'active':
     if exp has no redirect variation: continue        # not split-URL → skip in v1
     a ← assign(exp, { visitorId, now }, store)         # shared core; writes _testa_exp
     if a.isExcluded: continue
     change ← redirectChangeFor(exp, a.variationId)
     if !matchesForMode(canonical(req.url), change.from_url, mode): continue
     if hasRedirected(exp, store): continue             # _testa_redirected_<id>
     finalUrl ← buildRedirectUrl(req.url, change)        # merges query params
     if canonical(finalUrl) === canonical(req.url): continue   # no-op guard
     markRedirected(exp, store)
     return NextResponse.redirect(finalUrl, 307) with store's Set-Cookies

  return res    # no redirect; freshly-minted _testa_uuid (if any) still set
```

Every guard is the *same code* as `redirect/index.ts`, behind the `CookieStore`
seam — dedup, no-match, same-URL no-op, param-merge.

---

## Soft-navigation coverage (in scope — user requirement)

Split-URL redirects must also work on client-side SPA navigation, not just
initial/hard loads. Middleware alone doesn't cover every soft nav (a
Pages-Router soft nav to a fully static page never hits the server). **v1 covers
soft nav with two mechanisms — M1 and M2 below** — both reading the *same* sticky
`_testa_exp` cookie + `experiment-core`, so a visitor gets the same variant no
matter which fires. (A third, `<TestaLink>`, is deferred — see _Future
direction_.)

### M1 — middleware: the universal safety net (primary in v1)
Covers initial/hard loads (already the core flow) **and** App-Router RSC soft
navs that didn't go through `<TestaLink>`. On an App-Router `<Link>` transition
the client fetches the destination's **RSC payload** from the server and
middleware runs on that request; redirecting it makes the client router follow
to the variant, control RSC never returned → **no flash**. Always works,
requires no dev changes.

**Prefetch trap (must handle):** App Router prefetches `<Link>` targets (RSC
requests carrying `Next-Router-Prefetch: 1`) on hover/viewport, which also hit
middleware. We must **not** persist committing state on a prefetch — no
`_testa_redirected` cookie, no `Set-Cookie`, no (future) exposure — or
assignment side-effects fire for links nobody clicked. Rule: on a prefetch
request, compute but do not commit. Validated in the N.5 spike.

### M2 — `<TestaRouterGuard/>`: catch-all interceptor (optional)
For navigations that the middleware can't see — notably **Pages-Router-static**
soft nav, which never reaches the server. A small client component added once in
the layout; it hooks router navigation events, reads the sticky cookie via
`experiment-core` (no re-roll, no config re-fetch), and `router.replace()`s to
the variant on a control-URL match, aborting in `routeChangeStart` before the
control page renders to avoid a one-frame flash.

Both mechanisms live in the npm package — "Next.js is the integration" holds; no
external pixel. App-Router customers get flash-free soft nav from M1 alone; M2 is
the belt-and-suspenders for Pages-Router-static and anything M1 misses.

---

## Proposed task breakdown

| ID | Task | Blocked by |
|---|---|---|
| N.1 | Extract `packages/experiment-core` — `xxhash`, `assign`, `redirect/*`, packed `_testa_exp` codec, all behind `CookieStore`. Pixel refactored to consume it; existing pixel tests are the parity gate (zero behaviour change). | — |
| N.2 | `@testa/next` scaffold + `createTestaMiddleware()` + `NextCookieStore` + `_testa_uuid` minting. | N.1 |
| N.3 | `ConfigClient`: CDN pointer+immutable fetch with in-instance hash cache (adapter interface; Edge Config adapter behind O2). | N.2 |
| N.4 | Redirect decision loop (assign → match → 307 + cookies) for initial/hard loads. | N.2, N.3 |
| N.5 | **Soft-nav M1** — middleware handles App-Router RSC navigation requests (redirect the RSC request; prefetch-safe — no commit on `Next-Router-Prefetch`). Spike first to validate RSC-redirect mechanics. | N.4 |
| N.6 | **Soft-nav M2** — `<TestaRouterGuard/>` client component (router-events hook, cookie-first assignment, `router.replace` on control-URL match, Pages-Router `routeChangeStart` abort). | N.4 |
| N.7 | Example Next.js app in `demo/` (App **and** Pages router) + Playwright assertions proving **no control paint** on initial load AND soft nav. | N.5, N.6 |
| N.8 | crobot publish side: write `{hash}.json` + `current.json` (and/or Edge Config) on config save. (Cross-repo; coordinate per `AGENTS.md`.) | N.3 |

Each = one PR per `AGENTS.md`. N.1 is the only real risk; N.2–N.5 are mechanical
once the core is shared.

---

## Resolved questions (were open; now decided)

- **Both middleware + pixel?** No. Middleware is the sole v1 integration; pixel
  deferred.
- **Config source?** CDN hashed JSON (immutable + mutable pointer); Vercel Edge
  Config preferred on Vercel. Edge worker drops out.
- **Exposure dedup?** Deferred with analytics; when built, deterministic
  `event_id` across pre/post-redirect fires.
- **Consent?** Ignored in v1.
- **Package + repo?** `@testa/next`, published from this monorepo.
- **Runtime?** Next.js middleware (Edge Runtime), because the CF edge worker
  isn't in the Next request path; core is Node-compatible too. (App-Router RSC
  navigations *do* reach the middleware — that's what makes soft-nav Layer 1
  possible; Pages-Router-static soft nav is covered by Layer 2.)
- **Soft nav?** In scope for v1 via middleware RSC-redirect (universal safety net)
  + optional `<TestaRouterGuard/>` (Pages-Router-static catch-all). `<TestaLink>`
  (rewrite href at source, no redirect) deferred to a fast-follow.

## Still-open (lower stakes)

- **O2 — Edge Config vs CDN fetch** as the *primary* config adapter on Vercel.
  Both behind one `ConfigClient` interface; pick per deployment. Decide before N.3
  ships its default adapter.
- **N.4 sharp edge — redirecting RSC vs document** for App-Router soft nav. Needs
  a spike during N.4; may end up documented as "hard-nav only" for v1.

## Risks

- **SRM / re-roll (highest, but reduced).** Divergence between the middleware and
  the future pixel on bucketing or cookie format flips visitors mid-test. Fully
  mitigated by the single shared `experiment-core` + the pixel's existing
  bucketing/redirect test suite run as the parity gate for both hosts. Lower
  urgency in v1 since the pixel isn't present yet.
- **Config staleness.** In-instance cache could serve a stale experiment until the
  pointer revalidates. Mitigation: short pointer TTL / Edge Config; split-URL
  configs change rarely.
- **Middleware latency budget.** Runs on every matched request. Steady state must
  be a pointer cache-hit; bucketing is microseconds. Keep the matcher tight.
- **SPA soft-nav gap.** Documented boundary above; revisited when the pixel
  rejoins.
```
