/**
 * Per-experiment redirect-already-fired guard, over a `CookieStore`.
 *
 * Avoids redirect loops: if `from=/a` → `to=/b` matches and the same experiment
 * is also "active" on `/b`, we'd bounce back. The guard records "this visitor
 * already redirected for experiment X" and skips re-entry.
 *
 * Storage: `_testa_redirected_<expId>` cookie. `markRedirected` is a COMMITTING
 * write — the caller must skip it on prefetch requests (see @testa-soft/next).
 */

import { type CookieStore, REDIRECTED_TTL_SEC, redirectedName } from '../cookie-store.ts';

export function hasRedirected(store: CookieStore, experimentId: number | string): boolean {
  return store.get(redirectedName(experimentId)) === '1';
}

export function markRedirected(store: CookieStore, experimentId: number | string): void {
  store.set(redirectedName(experimentId), '1', { maxAgeSec: REDIRECTED_TTL_SEC });
}

export function clearRedirected(store: CookieStore, experimentId: number | string): void {
  store.set(redirectedName(experimentId), '', { maxAgeSec: 0 });
}
