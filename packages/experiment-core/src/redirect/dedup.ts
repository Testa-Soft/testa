/**
 * Per-experiment redirect loop-BREAKER, over a `CookieStore`.
 *
 * Breaks IMMEDIATE loops only: if `from=/a` → `to=/b` matches and the same (or
 * a paired) experiment would bounce back from `/b`, the guard stops the
 * ping-pong within its short window (`REDIRECTED_TTL_SEC`). It is NOT
 * persistence — a variant visitor landing on the control URL must be redirected
 * again on every later visit.
 *
 * Storage: `_testa_redirected_<expId>` cookie, value `'2'`. The value is a
 * format version: `'1'` cookies were written by builds where the guard lived 30
 * DAYS (locking client redirects to once-a-month); browsers still carry them,
 * so `'1'` is deliberately treated as NOT redirected and dies of old age.
 *
 * `markRedirected` is a COMMITTING write — the caller must skip it on prefetch
 * requests (see @testa-soft/next).
 */

import { type CookieStore, REDIRECTED_TTL_SEC, redirectedName } from '../cookie-store.ts';

/** Current marker value — see the format-version note in the file docblock. */
const REDIRECTED_MARK = '2';

export function hasRedirected(store: CookieStore, experimentId: number | string): boolean {
  return store.get(redirectedName(experimentId)) === REDIRECTED_MARK;
}

export function markRedirected(store: CookieStore, experimentId: number | string): void {
  store.set(redirectedName(experimentId), REDIRECTED_MARK, { maxAgeSec: REDIRECTED_TTL_SEC });
}

export function clearRedirected(store: CookieStore, experimentId: number | string): void {
  store.set(redirectedName(experimentId), '', { maxAgeSec: 0 });
}
