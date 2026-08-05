---
id: "N.4"
title: "Redirect decision loop — assign → match → 307 + cookies (initial/hard loads)"
phase: "N"
status: pending
estimate_days: 1.5
blocked_by: ["N.2", "N.3"]
files_to_create:
  - packages/next/src/redirect-loop.ts
  - packages/next/src/__tests__/redirect-loop.test.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - apps/pixel/src/runtime/redirect/index.ts
  - packages/experiment-core/src/redirect/index.ts
commits: []
completed_at: null
---

## Goal

Wire the server-side split-URL redirect decision loop into the middleware for
**initial / hard loads**: iterate active experiments, bucket the visitor with the
shared core, and for split-URL (redirect) experiments only, issue a `307` to the
variant URL with the assignment cookies set — flicker-free because the 307
precedes any HTML.

## Context

Split-URL uses a **redirect, not a rewrite** (PRD "Design decisions"): a split-URL
test has two genuinely distinct URLs (control `/a`, variant `/b`) and the variant
experience *is* the variant URL, so we `NextResponse.redirect(…, 307)`. It's
strictly better than the pixel's `location.replace()`, which paints control
first. (Rewrite-style same-URL variants belong to the future feature-flagging
product, not here.)

The loop is the PRD "Middleware request flow", every guard being the *same code*
as `redirect/index.ts` behind the `CookieStore` seam:

```
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

Cookie contract written here (middleware-owned, v1): `_testa_exp` (packed
assignment/exclusion/session, 30d, 3.16 codec) and `_testa_redirected_<expId>`
(once-per-experiment dedup, session/short). The `_testa_uuid` is already minted in
N.2. Because there is no pixel in v1, the middleware is the sole reader/writer and
can define the packed format now.

**Sharp edge (O-N.4):** redirecting RSC vs document for App-Router soft nav needs
a spike during this task; it may end up documented as "hard-nav only" for v1, with
soft nav handled in N.5. This task's contract is initial/hard loads.

## Acceptance criteria

- The middleware iterates `config.experiments` where `status === 'active'` and
  **skips any experiment with no redirect variation** (non-split-URL → skipped in
  v1).
- For a split-URL experiment where the visitor buckets to a variant whose
  `from_url` matches the current canonical URL, the middleware returns
  `NextResponse.redirect(finalUrl, 307)`.
- All guards from `redirect/index.ts` are enforced via the shared core: exclusion
  skip, no-match skip, `_testa_redirected_<id>` dedup, same-URL no-op guard, query
  param merge in `buildRedirectUrl`.
- `_testa_exp` (30d, packed 3.16 codec) and `_testa_redirected_<expId>`
  (session/short) are set on the redirect response via the `CookieStore`.
- When no experiment matches, the middleware returns `NextResponse.next()` with any
  freshly-minted `_testa_uuid` preserved.
- Bucketing is deterministic and sticky from request one (uuid minted + used in the
  same pass); no `Math.random()`.
- Spike outcome for RSC-vs-document redirect documented (feeds N.5).

## Implementation notes

- Reuse `experiment-core`'s `assign`, `redirectChangeFor`, `matchesForMode`,
  `buildRedirectUrl`, and dedup helpers — do not reimplement any guard.
- `canonical(url)` must match the pixel's canonicalization so match/no-op behave
  identically across hosts.
- Return early on the first matching redirect; do not stack redirects.

## Tests

- Bucket-to-variant + URL match → 307 to variant with correct cookies.
- Exclusion, no-match, already-redirected, same-URL no-op → no redirect
  (`NextResponse.next()`).
- Non-split-URL experiment → skipped.
- Query params on the incoming URL are merged into the variant URL.
- Deterministic: same visitor id → same variant across repeated requests.

## Out of scope

- Soft-nav RSC handling / prefetch trap — see N.5.
- `<TestaRouterGuard/>` client component — see N.6.
- Analytics / exposure emission — deferred entirely in v1.
