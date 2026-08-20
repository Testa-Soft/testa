/**
 * `createTestaProxy` — the one-line Next.js integration.
 *
 * This is the ONLY file that imports `next/server` at runtime; all decision
 * logic lives in the host-neutral `engine.ts` + experiment-core, so it stays
 * thin. Usage:
 *
 *   // middleware.ts
 *   import { createTestaProxy } from '@testa/next'
 *   export const middleware = createTestaProxy({ projectId: '3fa85f64e1c2b' })
 *   // Optional cost optimization (correctness never depends on it — see
 *   // request-filter.ts): a matcher skips the edge invocation on assets.
 *   export const config = { matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'] }
 */

import { ASSIGNMENT_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import {
  type VariationAppliedEvent,
  hasPendingDomChange,
  runExperiments,
} from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server';
import type { NextFetchEvent } from 'next/server';
import { applyRequestHeaders, isRedirect, toNextResponse } from './compose.ts';
import { ConfigClient, type ConfigSource } from './config.ts';
import { DEFAULT_CONFIG_HOST, DEFAULT_TRACKING_HOST, SHIELD_HEADER, readEnv } from './constants.ts';
import { NextCookieStore } from './cookie-store.ts';
import { resolveCookieDomain } from './domain.ts';
import { type SkipPath, shouldBypassRequest } from './request-filter.ts';
import { computePrefetchRedirect } from './soft-nav/prefetch-guard.ts';
import { isPrefetchRequest } from './soft-nav/rsc-redirect.ts';
import { emitExposure } from './tracking.ts';
import { ensureVisitorId } from './uuid.ts';

export type { VariationAppliedEvent };

// Re-exported from `./constants.ts` so the server entry can share them without
// importing this (edge-only) module, while existing imports keep working.
export { DEFAULT_CONFIG_HOST, DEFAULT_TRACKING_HOST, SHIELD_HEADER } from './constants.ts';

export interface TestaProxyOptions extends ConfigSource {
  /**
   * The project's id — the ONLY thing a normal integration passes. Config is
   * fetched from `{host}/api/v1/config/{projectId}`.
   */
  projectId?: string;
  /** @deprecated Alias for `projectId`. */
  projectSlug?: string;
  /**
   * Config host. Defaults to the package's built-in host (`DEFAULT_CONFIG_HOST`),
   * or the `TESTA_CONFIG_HOST` env var. Override here for local/staging.
   */
  host?: string;
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secureCookies?: boolean;
  /**
   * Session / exclusion-cooldown window in SECONDS (crobot 3.3.3 model): how long
   * a first-touch targeting verdict is cached and how long a conversion stays
   * attributed. Default 30 min (`SESSION_LENGTH_SEC`).
   */
  sessionLengthSec?: number;
  /**
   * Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.acme.com`).
   * Wins over `discoverRootDomain`.
   */
  cookieDomain?: string;
  /** Auto-derive the registrable domain from the request host for cookies. */
  discoverRootDomain?: boolean;
  /**
   * Server-side hook, fired for each variation the visitor is assigned on a
   * request (control + variant) — e.g. capture the exposure to PostHog server,
   * a warehouse, or a webhook. `ctx.waitUntil(promise)` keeps an async call alive
   * until it completes AFTER the response is sent (it never delays the response).
   * Guard on `event.firstAssignment` to fire once per visitor, not per request.
   * Errors/rejections are swallowed so a hook never breaks the request.
   */
  onVariationAssigned?: (
    event: VariationAppliedEvent,
    ctx: VariationHookContext,
  ) => void | Promise<void>;
  /**
   * Emit exposures (impressions) to the legacy `/api/leads` so experiment
   * results populate. Default true. Set false if you only want redirects, or if
   * the co-shipped pixel owns tracking on this site.
   */
  tracking?: boolean;
  /** Host for exposure tracking. Default: `TESTA_TRACKING_HOST` env or built-in. */
  trackingHost?: string;
  /**
   * Extra paths the proxy must pass through untouched, on top of the built-in
   * filter (`/_next/*`, `/api/*`, `/.well-known/*`, static-asset extensions).
   * A string matches as a segment-aligned prefix (`'/admin'` matches `/admin`
   * and `/admin/users`, not `/administrator`); a RegExp is tested against the
   * pathname.
   */
  skipPaths?: ReadonlyArray<SkipPath>;
  /**
   * Your own middleware logic, run INSIDE the proxy so both end up on the ONE
   * response Next.js allows (request-header overrides are wholesale per
   * response — two separately-built responses can't be merged). Semantics:
   * - Bypassed requests (`/api/*`, assets, `skipPaths`) delegate straight to
   *   the handler, so its headers still reach API routes testa skips.
   * - A split-URL redirect short-circuits — the handler is NOT called
   *   (nothing downstream renders).
   * - Otherwise the handler runs with `x-testa-shield` already in
   *   `req.headers`; clone them (`new Headers(req.headers)`) when overriding
   *   request headers. Testa merges its cookies onto the returned response and
   *   re-patches the shield override even if the handler returned a plain
   *   `NextResponse.next()`. Returning `null`/`undefined` means "continue".
   */
  handler?: TestaHandler;
}

/** Customer middleware logic composed inside the proxy — see `handler`. */
export type TestaHandler = (
  req: NextRequest,
  event?: NextFetchEvent,
) => Response | null | undefined | Promise<Response | null | undefined>;

export type TestaProxy = (req: NextRequest, event?: NextFetchEvent) => Promise<NextResponse>;

export function createTestaProxy(options: TestaProxyOptions): TestaProxy {
  const projectId = options.projectId ?? options.projectSlug;
  if (!projectId) {
    throw new Error('createTestaProxy: `projectId` is required');
  }
  const configClient = new ConfigClient(resolveConfigSource(options, projectId));
  const secure = options.secureCookies ?? true;
  const trackingEnabled = options.tracking ?? true;
  const trackingHost = (
    options.trackingHost ??
    readEnv('TESTA_TRACKING_HOST') ??
    DEFAULT_TRACKING_HOST
  ).replace(/\/+$/, '');

  return async function testaMiddleware(
    req: NextRequest,
    event?: NextFetchEvent,
  ): Promise<NextResponse> {
    // Blackbox safety net, BEFORE any config fetch or cookie work: never treat
    // assets / framework internals / API routes as pages, so the proxy is
    // correct even with no `config.matcher` at all (the matcher is then purely
    // a cost optimization — it skips the edge invocation entirely).
    if (shouldBypassRequest(new URL(req.url).pathname, options.skipPaths)) {
      return delegate(options.handler, req, event);
    }

    const cookieDomain = resolveCookieDomain(new URL(req.url).hostname, {
      ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
      ...(options.discoverRootDomain ? { discoverRootDomain: true } : {}),
    });
    const store = new NextCookieStore(req.cookies, {
      secure,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
    const config = await configClient.get(
      projectId,
      Date.now(),
      event?.waitUntil ? event.waitUntil.bind(event) : undefined,
      // Document load vs RSC soft-nav/prefetch — drives 'per-pageload' caching.
      req.headers.get('rsc') !== '1',
    );

    // No config → behave as a no-op pass-through (fail open) — THROUGH the
    // composed handler, so the customer's own middleware still runs.
    if (!config) return delegate(options.handler, req, event);

    // Soft-nav M1 prefetch trap: App Router prefetches `<Link>` targets (RSC
    // requests) on hover/viewport. We compute the decision but NEVER commit —
    // redirect the prefetch to the variant (warming the variant RSC into the
    // router cache so the click is flash-free) without writing any cookie or
    // emitting an exposure. See soft-nav/prefetch-guard.ts + rsc-redirect.ts.
    if (isPrefetchRequest(req)) {
      const redirectTo = computePrefetchRedirect(
        {
          config,
          currentUrl: req.url,
          visitorId: store.get(UUID_COOKIE),
          now: Date.now(),
          getCookie: (name) => store.get(name),
          ...(req.headers.get('user-agent')
            ? { userAgent: req.headers.get('user-agent') as string }
            : {}),
          ...(geoCountry(req) ? { country: geoCountry(req) as string } : {}),
        },
        store, // written into by the engine, then intentionally discarded (no applyTo)
      );
      return redirectTo
        ? NextResponse.redirect(new URL(redirectTo, req.url), 307)
        : delegate(options.handler, req, event);
    }

    const visitorId = ensureVisitorId(store);
    const result = runExperiments(
      {
        config,
        currentUrl: req.url,
        visitorId,
        now: Date.now(),
        getCookie: (name) => store.get(name),
        ...(req.headers.get('user-agent')
          ? { userAgent: req.headers.get('user-agent') as string }
          : {}),
        ...(geoCountry(req) ? { country: geoCountry(req) as string } : {}),
        ...(options.sessionLengthSec !== undefined
          ? { sessionLengthSec: options.sessionLengthSec }
          : {}),
      },
      store,
    );

    for (const applied of result.applied) {
      fireVariationAssigned(options.onVariationAssigned, applied, event);
      // Emit an exposure once per fresh enrollment (deduped server-side anyway).
      if (trackingEnabled && applied.firstAssignment && config.project_id != null) {
        const pending = emitExposure(trackingHost, {
          project_id: config.project_id,
          experiment: applied.experimentId,
          variation: applied.variationId,
          uuid: applied.visitorId,
          ...(applied.title ? { title: applied.title } : {}),
          url: applied.url,
        });
        if (event?.waitUntil) event.waitUntil(pending);
        else void pending;
      }
    }

    if (result.redirectTo) {
      const res = NextResponse.redirect(new URL(result.redirectTo, req.url), 307);
      store.applyTo(res.cookies);
      return res;
    }

    // Tell the app whether to raise the anti-flicker shield for THIS request:
    // only when the visitor has a pending DOM change on this page. Split-URL-only
    // projects and pages with nothing to change get `0`, so `<TestaGuard/>`
    // never overlays needlessly. Passed as a request header the RSC layout reads
    // via `headers()`. Runs on soft-nav RSC requests too, so it stays per-page.
    const shield = hasPendingDomChange(config, req.url, store.get(ASSIGNMENT_COOKIE));
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(SHIELD_HEADER, shield ? '1' : '0');

    const res = await resolveDownstream(options.handler, req, requestHeaders, event);
    store.applyTo(res.cookies);
    return res;
  };
}

/** Run the composed handler with the request untouched (bypass / no-config / prefetch paths). */
async function delegate(
  handler: TestaHandler | undefined,
  req: NextRequest,
  event: NextFetchEvent | undefined,
): Promise<NextResponse> {
  if (!handler) return NextResponse.next();
  const out = await handler(req, event);
  return toNextResponse(out, () => NextResponse.next());
}

/**
 * Pass-through path: run the composed handler with `x-testa-shield` already in
 * the request headers, then make sure the shield override survives whatever
 * response shape the handler returned (its own overrides, a plain `next()`, a
 * rewrite). Handler redirects are returned as-is — nothing downstream renders.
 */
async function resolveDownstream(
  handler: TestaHandler | undefined,
  req: NextRequest,
  requestHeaders: Headers,
  event: NextFetchEvent | undefined,
): Promise<NextResponse> {
  if (!handler) return NextResponse.next({ request: { headers: requestHeaders } });
  const downstreamReq = new NextRequest(req, { headers: requestHeaders });
  const out = await handler(downstreamReq, event);
  const res = toNextResponse(out, () =>
    NextResponse.next({ request: { headers: requestHeaders } }),
  );
  if (isRedirect(res)) return res;
  return applyRequestHeaders(
    res,
    { [SHIELD_HEADER]: requestHeaders.get(SHIELD_HEADER) ?? '0' },
    downstreamReq,
  );
}

/** Context passed to `onVariationAssigned` — keep an async task alive past the response. */
export interface VariationHookContext {
  /** Run `promise` to completion after the response is sent (never delays it). */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Invoke the hook without ever letting it break the request; keep async work alive. */
function fireVariationAssigned(
  listener: TestaProxyOptions['onVariationAssigned'],
  event: VariationAppliedEvent,
  fetchEvent: NextFetchEvent | undefined,
): void {
  if (!listener) return;
  const waitUntil = (promise: Promise<unknown>): void => {
    if (fetchEvent?.waitUntil) fetchEvent.waitUntil(promise.catch(() => undefined));
    else void promise.catch(() => undefined);
  };
  try {
    const r = listener(event, { waitUntil });
    // If the hook itself returned a promise, keep the worker alive for it too.
    if (r && typeof (r as Promise<void>).then === 'function') waitUntil(r as Promise<void>);
  } catch {
    // never break the request on a hook error
  }
}

/** Best-effort ISO country from common edge geo headers (Vercel / Cloudflare). */
function geoCountry(req: NextRequest): string | undefined {
  return (req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry') ?? undefined) as
    | string
    | undefined;
}

/**
 * Turn `{ projectId, host? }` into a concrete ConfigSource. An explicit
 * `config` / `loadConfig` / `configUrl` always wins; otherwise the config URL is
 * built from the resolved host + projectId, so the caller only needs projectId.
 */
function resolveConfigSource(options: TestaProxyOptions, projectId: string): ConfigSource {
  if (options.config || options.loadConfig || options.configUrl) return options;
  const host = (options.host ?? readEnv('TESTA_CONFIG_HOST') ?? DEFAULT_CONFIG_HOST).replace(
    /\/+$/,
    '',
  );
  return { ...options, configUrl: `${host}/api/v1/config/${projectId}` };
}
