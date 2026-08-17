/**
 * Prefetch guard (task N.5) — compute a split-URL redirect for a PREFETCH
 * request without committing anything.
 *
 * App Router prefetches `<Link>` targets on hover/viewport. Committing on a
 * prefetch would fire assignment side effects (Set-Cookie, `_testa_exp`,
 * exposure) for links nobody clicked. So on a prefetch we run the exact same
 * decision loop but treat it as strictly read-only:
 *
 *   - The caller discards the store (never calls `applyTo`), so the engine's
 *     buffered `_testa_exp` / uuid writes are dropped — no Set-Cookie, no
 *     persisted assignment, no exposure.
 *   - We only redirect the prefetch on a STABLE, cookie-sticky decision
 *     (`firstAssignment === false`): the visitor already has this assignment in
 *     `_testa_exp`, so warming the variant is guaranteed to match their real
 *     click. A FRESHLY bucketed visitor's decision is speculative — their real
 *     click mints a `_testa_uuid` and may bucket differently — so we pass those
 *     prefetches through untouched and let the committed click decide.
 *
 * Redirecting the prefetch to the variant warms the variant RSC into the router
 * cache so the eventual click lands flash-free — all without a side effect.
 */

import type { CookieStore } from '@testa-soft/experiment-core';
import { type EngineContext, runExperiments } from '../engine.ts';

export interface PrefetchComputeInput {
  config: EngineContext['config'];
  currentUrl: string;
  /** Existing `_testa_uuid`, or null. We NEVER mint one on a prefetch. */
  visitorId: string | null;
  now: number;
  getCookie: (name: string) => string | null;
  userAgent?: string;
  country?: string;
}

/**
 * Compute-but-don't-commit. Returns the variant URL to redirect the prefetch to,
 * or `null` to pass the prefetch through. The passed `store` is written into by
 * the engine but MUST be discarded by the caller (do not `applyTo` a response).
 */
export function computePrefetchRedirect(
  input: PrefetchComputeInput,
  store: CookieStore,
): string | null {
  const result = runExperiments(
    {
      config: input.config,
      currentUrl: input.currentUrl,
      // Empty id when none present: only used to bucket a not-yet-assigned
      // visitor, whose (speculative) fresh decision we discard below anyway.
      visitorId: input.visitorId ?? '',
      now: input.now,
      getCookie: input.getCookie,
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
    },
    store,
  );
  if (!result.redirectTo) return null;

  // Only warm the prefetch on a cookie-sticky (non-first) assignment.
  const redirected = result.applied.find((a) => a.redirected);
  if (!redirected || redirected.firstAssignment) return null;
  return result.redirectTo;
}
