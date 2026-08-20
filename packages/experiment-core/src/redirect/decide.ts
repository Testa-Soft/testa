/**
 * Host-agnostic split-URL redirect decision.
 *
 * Ported from `apps/pixel/src/runtime/redirect/index.ts::evaluateAndApply`, but
 * split into DECIDE (pure, read-only) and COMMIT (caller's job). The pixel calls
 * `location.replace`; the middleware issues a 307. Neither belongs in the core.
 *
 * `decideRedirect` performs every guard — invalid-target, no-match,
 * same-canonical-URL no-op — and returns the resolved destination.
 *
 * There is deliberately NO once-per-experiment dedup here: a variant visitor
 * landing on the control URL must be redirected on EVERY visit, no exceptions.
 * Loop safety is STATELESS — the already-at-destination + canonical-equality
 * checks below — never a cookie that suppresses legitimate redirects.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import type { CookieStore } from '../cookie-store.ts';
import { buildRedirectUrl, resolveMode } from './build-url.ts';
import { canonicalize, matchesForMode } from './match.ts';

export type RedirectChange = Extract<VariationChange, { type: 'redirect' }>;

export type RedirectReason = 'match' | 'aborted_invalid_target' | 'no_match' | 'skipped_same_url';

export interface RedirectDecision {
  /** True when the caller SHOULD redirect (and then commit dedup + cookies). */
  shouldRedirect: boolean;
  /** Resolved destination (with merged params), present iff shouldRedirect. */
  finalUrl?: string;
  reason: RedirectReason;
}

export interface RedirectInputs {
  experimentId: number | string;
  change: RedirectChange;
  /** Snapshot of the current URL at decision time. */
  currentUrl: string;
}

/**
 * Resolve a redirect destination for an ALREADY-ENROLLED visitor. Unlike
 * `decideRedirect`, it does NOT re-match `from_url` — enrollment (the page gate)
 * is the engine's job and uses the experiment's own match mode, while the
 * destination is built with the variation's mode. This is the match-mode
 * separation fix. Still loop-safe: skips when already at the destination.
 */
export function resolveRedirectDestination(
  change: RedirectChange,
  currentUrl: string,
): RedirectDecision {
  const mode = resolveMode(change);
  if (!change.to_url) return { shouldRedirect: false, reason: 'aborted_invalid_target' };

  if (mode !== 'query' && matchesForMode(currentUrl, change.to_url, mode)) {
    return { shouldRedirect: false, reason: 'skipped_same_url' };
  }

  let finalUrl: string;
  try {
    finalUrl = buildRedirectUrl(currentUrl, change);
  } catch {
    return { shouldRedirect: false, reason: 'aborted_invalid_target' };
  }

  if (canonicalize(finalUrl) === canonicalize(currentUrl)) {
    return { shouldRedirect: false, reason: 'skipped_same_url' };
  }

  return { shouldRedirect: true, finalUrl, reason: 'match' };
}

// `_store` is kept for signature compatibility (pixel/callers): the dedup-marker
// check that used it is gone — stickiness must ALWAYS win over any marker.
export function decideRedirect(inputs: RedirectInputs, _store: CookieStore): RedirectDecision {
  const { change, currentUrl } = inputs;
  const mode = resolveMode(change);

  if (!change.from_url || !change.to_url) {
    return { shouldRedirect: false, reason: 'aborted_invalid_target' };
  }

  if (!matchesForMode(currentUrl, change.from_url, mode)) {
    return { shouldRedirect: false, reason: 'no_match' };
  }

  // Already at the destination → no-op. Replaces the once-per-experiment dedup:
  // stateless, sticky-safe, and loop-safe even for broad `contains`/`regex`
  // `from_url` patterns that would otherwise re-match the variant URL.
  // (`query` mode's `to_url` is a param string, not a URL, so skip the check.)
  if (mode !== 'query' && matchesForMode(currentUrl, change.to_url, mode)) {
    return { shouldRedirect: false, reason: 'skipped_same_url' };
  }

  let finalUrl: string;
  try {
    finalUrl = buildRedirectUrl(currentUrl, change);
  } catch {
    return { shouldRedirect: false, reason: 'aborted_invalid_target' };
  }

  // Same canonical URL → no-op (covers query-mode + any residual self-target).
  if (canonicalize(finalUrl) === canonicalize(currentUrl)) {
    return { shouldRedirect: false, reason: 'skipped_same_url' };
  }

  return { shouldRedirect: true, finalUrl, reason: 'match' };
}
