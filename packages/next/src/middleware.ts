/**
 * `createTestaProxy` — the one-line Next.js integration.
 *
 * This file is a thin ASYNC executor around the shared, synchronous decision
 * pipeline in `proxy-core.ts` (which also powers `createTestaProxySync`); the
 * only work done here is awaiting the config and delegating to a possibly-async
 * customer handler. Usage:
 *
 *   // middleware.ts
 *   import { createTestaProxy } from '@testa/next'
 *   export const middleware = createTestaProxy({ projectId: '3fa85f64e1c2b' })
 *   // Optional cost optimization (correctness never depends on it — see
 *   // request-filter.ts): a matcher skips the edge invocation on assets.
 *   export const config = { matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'] }
 */

import type { VariationAppliedEvent } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import type { NextFetchEvent } from 'next/server.js';
import { isCrawlerUserAgent } from './bot.ts';
import { applyRequestHeaders, isRedirect, toNextResponse } from './compose.ts';
import { ConfigClient, type ConfigSource } from './config.ts';
import { buildConfigUrl } from './config-fetch.ts';
import { SHIELD_HEADER, readEnv } from './constants.ts';
import { createDebugEmitter, envDebugEnabled } from './debug.ts';
import {
  type VariationHookContext,
  decideProxyRequest,
  makeWaitUntil,
  prepareProxyRequest,
  resolveProxyPipeline,
} from './proxy-core.ts';
import { type SkipPath, isDocumentMethod, shouldBypassRequest } from './request-filter.ts';

export type { VariationAppliedEvent, VariationHookContext };

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
  const pipeline = resolveProxyPipeline<NextRequest>(options);
  const emitDebug = createDebugEmitter(options.debug ?? envDebugEnabled(readEnv('TESTA_DEBUG')));

  return async function testaMiddleware(
    req: NextRequest,
    event?: NextFetchEvent,
  ): Promise<NextResponse> {
    const waitUntil = makeWaitUntil(event);

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
    if (pipeline.skipBots && isCrawlerUserAgent(req.headers.get('user-agent'))) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, { url: req.url, bypass: 'bot' });
      return res;
    }

    const prepared = prepareProxyRequest(req, pipeline);
    const config = await configClient.get(
      projectId,
      Date.now(),
      waitUntil,
      // Document load vs RSC soft-nav/prefetch — drives 'per-pageload' caching.
      req.headers.get('rsc') !== '1',
    );

    // No config → behave as a no-op pass-through (fail open) — THROUGH the
    // composed handler, so the customer's own middleware still runs.
    if (!config) {
      const res = await delegate(options.handler, req, event);
      emitDebug?.(res, {
        url: prepared.publicUrl.href,
        urlSource: prepared.urlSource,
        bypass: 'no-config',
      });
      return res;
    }

    const decision = decideProxyRequest({
      req,
      config,
      prepared,
      pipeline,
      now: Date.now(),
      waitUntil,
    });

    if (decision.kind === 'redirect') {
      const res = NextResponse.redirect(decision.location, 307);
      if (decision.commit) prepared.store.applyTo(res.cookies);
      emitDebug?.(res, decision.debug);
      return res;
    }

    if (decision.kind === 'pass') {
      const res = await resolveDownstream(options.handler, req, decision.requestHeaders, event);
      prepared.store.applyTo(res.cookies);
      emitDebug?.(res, decision.debug);
      return res;
    }

    // 'delegate' — speculative pass-through etc.: testa adds nothing.
    const res = await delegate(options.handler, req, event);
    emitDebug?.(res, decision.debug);
    return res;
  };
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

/**
 * Turn `{ projectId, host? }` into a concrete ConfigSource. An explicit
 * `config` / `loadConfig` / `configUrl` always wins; otherwise the config URL is
 * built from the resolved host + projectId, so the caller only needs projectId.
 */
export function resolveConfigSource(options: TestaProxyOptions, projectId: string): ConfigSource {
  if (options.config || options.loadConfig || options.configUrl) return options;
  return { ...options, configUrl: buildConfigUrl(options.host ?? '', projectId) };
}
