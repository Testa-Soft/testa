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
import { NextRequest, NextResponse } from 'next/server.js';
import type { NextFetchEvent } from 'next/server.js';
import { isCrawlerUserAgent } from './bot.ts';
import { applyRequestHeaders, isRedirect, toNextResponse } from './compose.ts';
import { ConfigClient, type ConfigSource } from './config.ts';
import { DEFAULT_CONFIG_HOST, DEFAULT_TRACKING_HOST, SHIELD_HEADER, readEnv } from './constants.ts';
import { NextCookieStore } from './cookie-store.ts';
import { createDebugEmitter, envDebugEnabled } from './debug.ts';
import { resolveCookieDomain } from './domain.ts';
import { type SkipPath, isDocumentMethod, shouldBypassRequest } from './request-filter.ts';
import { stripFrameworkParams } from './soft-nav/framework-params.ts';
import { computePrefetchRedirect } from './soft-nav/prefetch-guard.ts';
import { isPrefetchRequest } from './soft-nav/rsc-redirect.ts';
import { emitExposure } from './tracking.ts';
import { type PublicHostOption, resolvePublicUrlDetailed } from './url-resolver.ts';
import { ensureVisitorId } from './uuid.ts';

export type { VariationAppliedEvent };

/** Where the bucketing/redirect decision happens. See `decisions`. */
export type ProxyDecisionMode = 'hybrid' | 'server' | 'client';

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
   * The site's PUBLIC host, for topologies where the container/ingress layer
   * (k8s, istio) rewrites `Host` before the request reaches Next.js and the
   * proxy would otherwise see an internal URL (`pod-ip:3000`) — which makes
   * split-URL targeting silently never match. Accepts `'www.acme.com'`,
   * a full origin `'https://www.acme.com'`, or a per-request callback (e.g.
   * multi-tenant). Env alternative: `TESTA_PUBLIC_HOST`. When unset, the
   * public URL is recovered from `x-testa-host` / RFC 7239 `Forwarded` /
   * `X-Forwarded-Host` + `X-Forwarded-Proto` headers, then `Host`.
   */
  publicHost?: string | ((req: NextRequest) => string | null | undefined);
  /**
   * Emit a per-request decision trace: a `[testa] {…}` console line AND an
   * `x-testa-debug` response header (readable in the browser network tab /
   * `curl -sI`, no log access needed) carrying the resolved public URL and
   * which mechanism produced it, the bypass reason if any (method / path /
   * no-config), assignments, redirect target, and shield verdict. Also
   * enabled via `TESTA_DEBUG=1`. Off by default — don't leave on in
   * production; the header exposes experiment internals.
   */
  debug?: boolean;
  /**
   * WHERE the bucketing/redirect decision is made, and what happens when this
   * server instance has no config in memory yet (a cold start).
   *
   * - `'hybrid'` (default) — decide server-side whenever the config is already
   *   in memory; on a cold instance pass the request through and let the
   *   CLIENT engine decide for that one pageview (it fetches its own config,
   *   and `<TestaGuard/>` hides the page meanwhile). No request ever waits on
   *   the network. Best on serverless, where an isolate that paid a blocking
   *   fetch is often torn down before it can reuse the result.
   * - `'server'` — always decide server-side, awaiting the config on a cold
   *   instance (capped by `fetchTimeoutMs`, default 400ms; on expiry the
   *   request proceeds without experiments). Every visitor gets the
   *   flicker-free redirect, at the cost of latency on cold requests. Best on
   *   long-lived servers, where that cost is paid once and amortised.
   * - `'client'` — never fetch or decide server-side; always pass through with
   *   the shield raised and let the client own everything. Skips the
   *   background refreshes that a sparse-traffic serverless deployment would
   *   otherwise discard unused.
   *
   * Assignment is cookie-pinned in every mode, so switching does not re-bucket
   * anyone — only where and when the decision happens changes.
   */
  decisions?: ProxyDecisionMode;
  /**
   * Latency budget (ms) for the cold fetch under `decisions: 'server'`.
   * Default 400. Other modes never block, so it does not apply.
   */
  fetchTimeoutMs?: number;
  /**
   * Skip experiments for crawlers, scripts, and monitors (user-agent based —
   * Googlebot, curl, HeadlessChrome, UptimeRobot, …). Default true: bots get
   * a clean pass-through — no assignment cookies, no redirects, no exposures —
   * so they never inflate visitor counts or skew results, and search engines
   * consistently see the control. Set false to treat them as visitors.
   * NOTE: this means `curl` shows control unless you send a browser UA
   * (`curl -A 'Mozilla/5.0 …'`); the `debug` trace marks these `bypass: bot`.
   */
  skipBots?: boolean;
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
  const publicHost: PublicHostOption<NextRequest> | undefined =
    options.publicHost ?? readEnv('TESTA_PUBLIC_HOST');
  const emitDebug = createDebugEmitter(options.debug ?? envDebugEnabled(readEnv('TESTA_DEBUG')));
  const skipBots = options.skipBots ?? true;

  /**
   * The proxy proper. Wrapped by `testaMiddleware` below, which guarantees a
   * response even if this throws — an experiment tool must never be able to
   * take a customer's site down.
   */
  const decide = async (req: NextRequest, event?: NextFetchEvent): Promise<NextResponse> => {
    // Blackbox safety net, BEFORE any config fetch or cookie work: never treat
    // assets / framework internals / API routes — or non-GET/HEAD requests
    // (Server Actions / form posts hit the page URL with POST) — as pages, so
    // the proxy is correct even with no `config.matcher` at all (the matcher
    // is then purely a cost optimization — it skips the edge invocation).
    if (
      !isDocumentMethod(req.method) ||
      shouldBypassRequest(new URL(req.url).pathname, options.skipPaths)
    ) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, {
        url: req.url,
        bypass: isDocumentMethod(req.method) ? 'path' : 'method',
        method: req.method,
      });
      return res;
    }

    // Crawlers/scripts/monitors are never experiment traffic: no assignment,
    // no redirect, no exposure — they'd inflate visitor counts and skew
    // results, and search engines should consistently see the control.
    if (skipBots && isCrawlerUserAgent(req.headers.get('user-agent'))) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, { url: req.url, bypass: 'bot' });
      return res;
    }

    // The URL the VISITOR requested — `req.url` can carry an internal host on
    // self-hosted container/ingress stacks (istio et al. rewrite `Host`), which
    // would break split-URL targeting, cookie discovery, and redirect bases.
    const { url: resolvedUrl, source: urlSource } = resolvePublicUrlDetailed(req, publicHost);
    // Drop Next's OWN query params (`_rsc` on an App Router soft nav, `__next*`
    // plumbing) before anything matches against this URL or builds a redirect
    // from it. By name only — nothing the visitor typed is ever removed. See
    // framework-params.ts.
    const publicUrl = stripFrameworkParams(resolvedUrl);

    const cookieDomain = resolveCookieDomain(publicUrl.hostname, {
      ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
      ...(options.discoverRootDomain ? { discoverRootDomain: true } : {}),
    });
    const store = new NextCookieStore(req.cookies, {
      secure,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
    // `decisions: 'client'` — never resolve a config here at all, so no fetch
    // (and no background refresh) is ever issued from the request path.
    const config =
      options.decisions === 'client'
        ? null
        : await configClient.get(
            projectId,
            Date.now(),
            event?.waitUntil ? event.waitUntil.bind(event) : undefined,
            // Document load vs RSC soft-nav/prefetch — drives 'per-pageload' caching.
            req.headers.get('rsc') !== '1',
          );

    // No config in memory (cold instance, or refreshes failing past the stale
    // bound) → pass through — THROUGH the composed handler, so the customer's
    // own middleware still runs — and hand this pageview to the client engine,
    // which fetches its own config and owns the decision, redirect included.
    //
    // The shield is raised PESSIMISTICALLY here: without a config we cannot
    // know whether this page has anything to hide, and a client-side redirect
    // or DOM apply is exactly the case that flashes without one. Hiding costs
    // an invisible paint bounded by the snippet's reveal timeout; not hiding
    // costs a visible flash of the control page. `<TestaGuard/>` reads this
    // header, and `<TestaProvider/>` reveals once it has decided.
    if (!config) {
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set(SHIELD_HEADER, '1');
      const res = await resolveDownstream(options.handler, req, requestHeaders, event);
      emitDebug?.(res, { url: publicUrl.href, urlSource, bypass: 'no-config', shield: true });
      return res;
    }

    // Speculative loads — compute the decision but NEVER commit (no cookie,
    // no exposure), while still returning the redirect:
    //   - prefetches: App Router `<Link>` RSC prefetches AND Speculation-Rules
    //     full-document prefetch/prerenders (Sec-Purpose) — redirecting them
    //     warms the variant so the real navigation is flash-free;
    //   - HEAD: curl -I / uptime monitors see the true redirect behavior
    //     without minting visitors or firing exposures.
    // See soft-nav/prefetch-guard.ts + rsc-redirect.ts.
    const speculative = isPrefetchRequest(req)
      ? ('prefetch' as const)
      : req.method === 'HEAD'
        ? ('head' as const)
        : undefined;
    if (speculative) {
      const redirectTo = computePrefetchRedirect(
        {
          config,
          currentUrl: publicUrl.href,
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
      const res = redirectTo
        ? NextResponse.redirect(new URL(redirectTo, publicUrl), 307)
        : await delegate(options.handler, req, event);
      emitDebug?.(res, {
        url: publicUrl.href,
        urlSource,
        speculative,
        ...(redirectTo ? { redirect: redirectTo } : {}),
      });
      return res;
    }

    const visitorId = ensureVisitorId(store);
    const result = runExperiments(
      {
        config,
        currentUrl: publicUrl.href,
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
        const pending = emitExposure(
          trackingHost,
          {
            project_id: config.project_id,
            experiment: applied.experimentId,
            variation: applied.variationId,
            uuid: applied.visitorId,
            ...(applied.title ? { title: applied.title } : {}),
            url: applied.url,
          },
          // The VISITOR's context, not ours — this POST is made by the server.
          { userAgent: req.headers.get('user-agent'), clientIp: clientIpOf(req) },
        );
        if (event?.waitUntil) event.waitUntil(pending);
        else void pending;
      }
    }

    if (result.redirectTo) {
      const res = NextResponse.redirect(new URL(result.redirectTo, publicUrl), 307);
      store.applyTo(res.cookies);
      emitDebug?.(res, {
        url: publicUrl.href,
        urlSource,
        visitor: visitorId,
        configHash: config.config_hash,
        applied: summarizeApplied(result.applied),
        redirect: result.redirectTo,
      });
      return res;
    }

    // Tell the app whether to raise the anti-flicker shield for THIS request:
    // only when the visitor has a pending DOM change on this page. Split-URL-only
    // projects and pages with nothing to change get `0`, so `<TestaGuard/>`
    // never overlays needlessly. Passed as a request header the RSC layout reads
    // via `headers()`. Runs on soft-nav RSC requests too, so it stays per-page.
    const shield = hasPendingDomChange(config, publicUrl.href, store.get(ASSIGNMENT_COOKIE));
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(SHIELD_HEADER, shield ? '1' : '0');

    const res = await resolveDownstream(options.handler, req, requestHeaders, event);
    store.applyTo(res.cookies);
    emitDebug?.(res, {
      url: publicUrl.href,
      urlSource,
      visitor: visitorId,
      configHash: config.config_hash,
      applied: summarizeApplied(result.applied),
      shield,
    });
    return res;
  };

  return async function testaMiddleware(
    req: NextRequest,
    event?: NextFetchEvent,
  ): Promise<NextResponse> {
    try {
      return await decide(req, event);
    } catch (error) {
      // Fail open, loudly. Individual steps already fail open on their own (a
      // config fetch, a hook, an exposure); this covers the ones nobody
      // predicted. The request continues to the customer's own middleware and
      // then to the app, with its request headers intact — the visitor gets an
      // unexperimented pageview instead of a 500.
      console.error('[testa] proxy failed, passing the request through:', error);
      try {
        return await delegate(options.handler, req, event);
      } catch {
        return NextResponse.next({ request: { headers: req.headers } });
      }
    }
  };
}

/**
 * The visitor's IP as the proxy sees it: the client-nearest entry of
 * `X-Forwarded-For`, else `X-Real-IP`. Null on runtimes that expose neither, in
 * which case nothing is forwarded.
 */
function clientIpOf(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip');
}

/** Compact per-assignment summary for the debug trace. */
function summarizeApplied(
  applied: ReadonlyArray<VariationAppliedEvent>,
): ReadonlyArray<{ experiment: number; variation: number; first: boolean }> {
  return applied.map((a) => ({
    experiment: a.experimentId,
    variation: a.variationId,
    first: a.firstAssignment,
  }));
}

/**
 * Bypass / no-config / prefetch paths: testa adds nothing of its own, but must
 * stay TRANSPARENT to upstream request mutation — a customer proxy that runs
 * first and tail-calls testa with a mutated `NextRequest` (extra request
 * headers) expects those headers to reach the app on every path. A bare
 * `NextResponse.next()` would forward the ORIGINAL headers instead, silently
 * dropping the mutations, so we always emit `req.headers` as the override set.
 */
async function delegate(
  handler: TestaHandler | undefined,
  req: NextRequest,
  event: NextFetchEvent | undefined,
): Promise<NextResponse> {
  const forward = (): NextResponse => NextResponse.next({ request: { headers: req.headers } });
  if (!handler) return forward();
  const out = await handler(req, event);
  const res = toNextResponse(out, forward);
  // A plain `next()` from the handler still forwards the (possibly mutated)
  // request headers; a handler that set its own overrides keeps them as-is.
  return isRedirect(res) ? res : applyRequestHeaders(res, {}, req);
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
  // `decisions: 'server'` is the only mode that lets a request wait on a fetch.
  const blockOnCold = options.decisions === 'server';
  if (options.config || options.loadConfig || options.configUrl) return { ...options, blockOnCold };
  const host = (options.host ?? readEnv('TESTA_CONFIG_HOST') ?? DEFAULT_CONFIG_HOST).replace(
    /\/+$/,
    '',
  );
  return { ...options, blockOnCold, configUrl: `${host}/api/v1/config/${projectId}` };
}
