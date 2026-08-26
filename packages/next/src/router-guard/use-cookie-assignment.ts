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

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  EXCLUDED_VARIATION_ID,
  type RedirectChange,
  canonicalize,
  matchesPageRule,
  parsePacked,
  resolveRedirectDestination,
} from '@testa-soft/experiment-core';

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
    // PAGE RULE — the same gate the engine applies before it resolves a
    // redirect, and the reason `resolveRedirectDestination` doesn't re-check
    // `from_url` itself. Without it this loop hijacks EVERY navigation: an
    // `exact`-mode destination ignores where you currently are, so a visitor
    // holding a redirect-variant assignment gets sent to the variant URL from
    // any page on the site. (`contains`/`regex` modes hid it — their build step
    // leaves a non-matching URL unchanged, which the already-at-destination
    // check then swallows.)
    if (!matchesPageRule(input.currentUrl, experiment.rules)) continue;
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
  /**
   * Leave the origin — used only when the variant lives on another domain,
   * which the Pages Router cannot route to. Typically
   * `(url) => window.location.replace(url)`.
   */
  navigate?: (url: string) => void;
}

/**
 * The destination as a router PATH when it shares the current origin, or null
 * when it doesn't (a cross-domain split URL). Both inputs are absolute.
 */
export function sameOriginPath(destination: string, current: string): string | null {
  try {
    const dest = new URL(destination);
    if (dest.origin !== new URL(current).origin) return null;
    return `${dest.pathname}${dest.search}${dest.hash}`;
  } catch {
    // Not parseable as absolute — a relative destination is already a path.
    return destination;
  }
}

/** Message of the error thrown to abort the in-flight Pages-Router navigation. */
export const ROUTE_ABORT = 'testa-router-guard: redirecting to variant';

/**
 * Cancel the navigation Next is in the middle of.
 *
 * Aborting from `routeChangeStart` is Next's own documented mechanism, and it
 * cannot be done quietly: the router emits that event OUTSIDE its try block
 * (`Router.change`), so whatever the handler throws escapes `change()` and
 * rejects the promise `router.push` returned — which `next/link` does not
 * catch. Hence `Uncaught (in promise) …` in the console on every redirect,
 * however the thrown value is shaped. `cancelled` is set because Next's other
 * failure paths do look for it.
 *
 * The rejection is swallowed by the listener installed in
 * {@link installRouterGuard} — the only place that can, since the promise
 * belongs to whoever called `push`.
 */
function abortNavigation(): never {
  const error = new Error(ROUTE_ABORT) as Error & { cancelled: boolean };
  error.cancelled = true;
  throw error;
}

/** Is this rejection our own navigation abort (and nobody else's)? */
function isAbortRejection(reason: unknown): boolean {
  if (typeof reason === 'string') return reason === ROUTE_ABORT;
  return reason instanceof Error && reason.message === ROUTE_ABORT;
}

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

    // The Pages Router routes PATHS. Handing `router.replace` an absolute URL
    // (which is how a crobot-authored `to_url` arrives) makes Next resolve it
    // against the current route and merge that route's interpolated params into
    // the query — `/question/female/1` picks up `?gender=male&step=1` on the way
    // through. A cross-origin destination it cannot route at all, so that one
    // goes to the browser.
    const routePath = sameOriginPath(redirectTo, target);
    if (routePath === null) {
      deps.navigate?.(redirectTo);
    } else {
      router.replace(routePath);
    }
    // Abort the in-flight navigation so the control route never renders.
    abortNavigation();
  };
  router.events.on('routeChangeStart', handler);

  // Keep our own abort out of the console. Scoped as tightly as it can be: it
  // only ever calls preventDefault for a rejection carrying ROUTE_ABORT, so a
  // real unhandled rejection in the host app still reports normally.
  const swallowAbort = (event: PromiseRejectionEvent): void => {
    if (isAbortRejection(event.reason)) event.preventDefault();
  };
  const target = typeof window === 'undefined' ? undefined : window;
  target?.addEventListener('unhandledrejection', swallowAbort);

  return () => {
    router.events.off('routeChangeStart', handler);
    target?.removeEventListener('unhandledrejection', swallowAbort);
  };
}
