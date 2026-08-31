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
 *
 * REWRITE variants need the same treatment for a different reason. A rewrite is
 * served AT the control URL, so a prefetch left alone caches the CONTROL payload
 * under exactly the key the click will read — and the soft nav then renders
 * control for a visitor assigned to the variant. Warming it means answering the
 * prefetch with the rewrite, which is why this returns a delivery mode rather
 * than a bare URL.
 */

import type { CookieStore } from '@testa-soft/experiment-core';
import { type EngineContext, runExperiments } from '@testa-soft/experiment-core';

export interface PrefetchComputeInput {
  config: EngineContext['config'];
  currentUrl: string;
  /** Existing `_testa_uuid`, or null. We NEVER mint one on a prefetch. */
  visitorId: string | null;
  now: number;
  getCookie: (name: string) => string | null;
  userAgent?: string;
  country?: string;
  /** Whether the caller can serve a rewrite (a server can; see EngineContext). */
  canRewrite?: boolean;
}

/** How the caller should answer a prefetch it decided to warm. */
export interface PrefetchDecision {
  /** Destination — to redirect to, or to serve in place. */
  url: string;
  delivery: 'redirect' | 'rewrite';
}

/**
 * Compute-but-don't-commit. Returns how to warm the prefetch, or `null` to pass
 * it through. The passed `store` is written into by the engine but MUST be
 * discarded by the caller (do not `applyTo` a response).
 */
export function computePrefetchRedirect(
  input: PrefetchComputeInput,
  store: CookieStore,
): PrefetchDecision | null {
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
      ...(input.canRewrite !== undefined ? { canRewrite: input.canRewrite } : {}),
    },
    store,
  );

  const url = result.redirectTo ?? result.rewriteTo;
  if (!url) return null;
  const delivery = result.redirectTo ? ('redirect' as const) : ('rewrite' as const);

  // Only warm the prefetch on a cookie-sticky (non-first) assignment — a freshly
  // bucketed visitor's decision is speculative and their real click may differ.
  const applied = result.applied.find((a) => a.delivery === delivery);
  if (!applied || applied.firstAssignment) return null;
  return { url, delivery };
}
