/**
 * App-Router RSC soft-navigation detection (task N.5, M1 — the universal safety net).
 *
 * Mechanism (spike outcome):
 *   On an App-Router `<Link>` transition the client router fetches the
 *   destination's React Server Component payload with an `RSC: 1` header, and
 *   middleware runs on that request. Returning a 307 makes the client router
 *   FOLLOW the redirect to the variant — the control RSC is never returned, so
 *   nothing paints. This is the same 307 a hard load uses, so hard loads and
 *   committed RSC navs share ONE decision path in the middleware; these
 *   predicates are informational (and scope the prefetch optimisation), not a
 *   gate on the redirect itself.
 *
 * Prefetch boundary:
 *   App Router prefetches `<Link>` targets on hover/viewport (`Next-Router-
 *   Prefetch: 1`). Those also hit middleware and MUST NOT commit assignment
 *   side effects — see `prefetch-guard.ts`.
 *
 * No `next/server` runtime import — typed against the `NextRequest` header shape
 * so this stays unit-testable with a plain `Headers`-backed fake.
 */

export interface RequestLike {
  headers: { get(name: string): string | null };
}

/** True for an App-Router RSC navigation/prefetch fetch (`RSC: 1`). */
export function isRscRequest(req: RequestLike): boolean {
  return req.headers.get('rsc') === '1';
}

/**
 * True for a prefetch warm-up — App Router (`Next-Router-Prefetch: 1`), the
 * legacy `Purpose: prefetch` hint, or Chrome Speculation Rules (`Sec-Purpose:
 * prefetch` / `prefetch;prerender`, which Next.js full-page prefetches use —
 * a FULL DOCUMENT request for a page the visitor may never see, so committing
 * an assignment or exposure on it would skew results). Checked BEFORE
 * {@link isRscRequest} so a prefetched RSC request is treated as a prefetch
 * (compute, never commit).
 */
export function isPrefetchRequest(req: RequestLike): boolean {
  const h = req.headers;
  if (h.get('next-router-prefetch') === '1' || h.get('purpose') === 'prefetch') return true;
  // Next marks the data prefetch it makes for a Pages Router `<Link>` — without
  // this the warm-up for a page the visitor may never open looks like a
  // pageview, and gets a cookie and an exposure.
  if (h.get('x-middleware-prefetch') === '1') return true;
  return (h.get('sec-purpose') ?? '').toLowerCase().includes('prefetch');
}
