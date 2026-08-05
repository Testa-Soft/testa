/**
 * Cookie-first assignment resolution for `<TestaRouterGuard/>` (task N.6, M2).
 *
 * The router guard is the catch-all for soft navigations the middleware can't
 * see — notably Pages-Router-static navs that never hit the server. It is
 * strictly COOKIE-FIRST: it reads the sticky `_testa_exp` assignment (already
 * set by the middleware on a prior request) and, on a navigation to a control
 * URL for an experiment the visitor is bucketed to a redirect variant of,
 * returns the variant URL. It NEVER re-buckets, mints, or writes anything — it
 * only redistributes an assignment that already happened, so it can never drift
 * from the server core.
 *
 * All logic is pure / framework-agnostic here; the React glue is the tiny
 * `TestaRouterGuard.tsx` on top.
 */

import {
  EXCLUDED_VARIATION_ID,
  type RedirectChange,
  canonicalize,
  parsePacked,
  resolveRedirectDestination,
} from '@testa-platform/experiment-core';
import type { ProjectConfig } from '@testa-platform/shared-types';

export interface GuardResolveInput {
  config: ProjectConfig;
  /** Absolute URL being navigated TO. */
  currentUrl: string;
  /** Raw `_testa_exp` cookie value, or null. */
  cookieValue: string | null;
}

/**
 * Given the sticky cookie + destination URL, return the variant URL to
 * `router.replace()` to, or null to let navigation proceed. Cookie-first: only
 * experiments the visitor already has an assignment for are considered.
 */
export function resolveGuardRedirect(input: GuardResolveInput): string | null {
  const assignments = parsePacked(input.cookieValue);
  if (assignments.size === 0) return null;

  for (const experiment of input.config.experiments) {
    if (experiment.status !== 'active') continue;
    const state = assignments.get(Number(experiment.experiment_id));
    if (!state || state.excluded || state.variation === EXCLUDED_VARIATION_ID) continue;

    const variation = experiment.variations.find((v) => v.variation_id === state.variation);
    const change = variation?.changes.find((c): c is RedirectChange => c.type === 'redirect');
    if (!change) continue;

    const dest = resolveRedirectDestination(change, input.currentUrl);
    if (dest.shouldRedirect && dest.finalUrl) return dest.finalUrl;
  }
  return null;
}

/** Minimal Pages-Router shape the guard needs — kept tiny so it fakes cleanly. */
export interface GuardRouter {
  events: {
    on(event: 'routeChangeStart', handler: (url: string) => void): void;
    off(event: 'routeChangeStart', handler: (url: string) => void): void;
  };
  replace(url: string): unknown;
}

export interface GuardDeps {
  config: ProjectConfig;
  /** Read the raw `_testa_exp` cookie (e.g. from `document.cookie`). */
  getCookieValue: () => string | null;
  /** Resolve a router path (`/pricing`) to an absolute URL for matching. */
  toAbsoluteUrl: (path: string) => string;
}

/** Thrown to abort the in-flight Pages-Router navigation (Next's documented mechanism). */
export const ROUTE_ABORT = 'testa-router-guard: redirecting to variant';

/**
 * Subscribe the guard to `routeChangeStart`. On a control-URL match it
 * `router.replace()`s to the variant and throws {@link ROUTE_ABORT} to abort the
 * current navigation BEFORE the control page renders (no one-frame flash).
 * Returns an unsubscribe function.
 */
export function installRouterGuard(router: GuardRouter, deps: GuardDeps): () => void {
  const handler = (path: string): void => {
    let target: string;
    try {
      target = deps.toAbsoluteUrl(path);
    } catch {
      return;
    }
    const redirectTo = resolveGuardRedirect({
      config: deps.config,
      currentUrl: target,
      cookieValue: deps.getCookieValue(),
    });
    if (!redirectTo || canonicalize(redirectTo) === canonicalize(target)) return;
    router.replace(redirectTo);
    // Abort the in-flight navigation so the control route never renders.
    throw ROUTE_ABORT;
  };
  router.events.on('routeChangeStart', handler);
  return () => router.events.off('routeChangeStart', handler);
}
