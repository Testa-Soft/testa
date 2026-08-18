/**
 * `createTestaMiddleware` — the one-line Next.js integration.
 *
 * This is the ONLY file that imports `next/server` at runtime; all decision
 * logic lives in the host-neutral `engine.ts` + experiment-core, so it stays
 * thin. Usage:
 *
 *   // middleware.ts
 *   import { createTestaMiddleware } from '@testa/next'
 *   export const middleware = createTestaMiddleware({ projectSlug: 'acme', config })
 *   export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'] }
 */

import { ASSIGNMENT_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import {
  type VariationAppliedEvent,
  hasPendingDomChange,
  runExperiments,
} from '@testa-soft/experiment-core';
import { NextResponse } from 'next/server';
import type { NextFetchEvent, NextRequest } from 'next/server';
import { ConfigClient, type ConfigSource } from './config.ts';
import { NextCookieStore } from './cookie-store.ts';
import { resolveCookieDomain } from './domain.ts';
import { computePrefetchRedirect } from './soft-nav/prefetch-guard.ts';
import { isPrefetchRequest } from './soft-nav/rsc-redirect.ts';
import { emitExposure } from './tracking.ts';
import { ensureVisitorId } from './uuid.ts';

export type { VariationAppliedEvent };

/**
 * Baked-in default config host. A client integration only needs `{ projectId }`;
 * the package already knows where to fetch config from. Override per-deployment
 * with the `host` option (or the `TESTA_CONFIG_HOST` env var).
 */
export const DEFAULT_CONFIG_HOST = 'https://config.testa-soft.tech';

/** Default host for exposure/conversion tracking (crobot's `/api/leads`). */
export const DEFAULT_TRACKING_HOST = 'https://app.testa-soft.tech';

export interface TestaMiddlewareOptions extends ConfigSource {
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
   * Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.acme.com`).
   * Wins over `discoverRootDomain`.
   */
  cookieDomain?: string;
  /** Auto-derive the registrable domain from the request host for cookies. */
  discoverRootDomain?: boolean;
  /**
   * Called for each variation applied on a request (control + variant), giving
   * the customer the assignment data to do whatever they need (log, forward to
   * their analytics, emit a lead). Errors and rejections are swallowed so a
   * listener never breaks the request. Not awaited — keep it fast or fire-and-forget.
   */
  onVariationApplied?: (event: VariationAppliedEvent) => void | Promise<void>;
  /**
   * Emit exposures (impressions) to the legacy `/api/leads` so experiment
   * results populate. Default true. Set false if you only want redirects, or if
   * the co-shipped pixel owns tracking on this site.
   */
  tracking?: boolean;
  /** Host for exposure tracking. Default: `TESTA_TRACKING_HOST` env or built-in. */
  trackingHost?: string;
}

export type TestaMiddleware = (req: NextRequest, event?: NextFetchEvent) => Promise<NextResponse>;

export function createTestaMiddleware(options: TestaMiddlewareOptions): TestaMiddleware {
  const projectId = options.projectId ?? options.projectSlug;
  if (!projectId) {
    throw new Error('createTestaMiddleware: `projectId` is required');
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
    const cookieDomain = resolveCookieDomain(new URL(req.url).hostname, {
      ...(options.cookieDomain ? { cookieDomain: options.cookieDomain } : {}),
      ...(options.discoverRootDomain ? { discoverRootDomain: true } : {}),
    });
    const store = new NextCookieStore(req.cookies, {
      secure,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
    const config = await configClient.get(projectId, Date.now());

    // No config → behave as a no-op pass-through (fail open).
    if (!config) return NextResponse.next();

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
        : NextResponse.next();
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
      },
      store,
    );

    for (const applied of result.applied) {
      emitVariationApplied(options.onVariationApplied, applied);
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
    // projects and pages with nothing to change get `0`, so `<TestaShield/>`
    // never overlays needlessly. Passed as a request header the RSC layout reads
    // via `headers()`. Runs on soft-nav RSC requests too, so it stays per-page.
    const shield = hasPendingDomChange(config, req.url, store.get(ASSIGNMENT_COOKIE));
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(SHIELD_HEADER, shield ? '1' : '0');

    const res = NextResponse.next({ request: { headers: requestHeaders } });
    store.applyTo(res.cookies);
    return res;
  };
}

/** Request header the middleware sets so the layout can gate `<TestaShield/>`. */
export const SHIELD_HEADER = 'x-testa-shield';

/** Invoke the listener without ever letting it break the request. */
function emitVariationApplied(
  listener: TestaMiddlewareOptions['onVariationApplied'],
  event: VariationAppliedEvent,
): void {
  if (!listener) return;
  try {
    const r = listener(event);
    if (r && typeof (r as Promise<void>).then === 'function') {
      (r as Promise<void>).catch(() => undefined);
    }
  } catch {
    // never break the request on a listener error
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
function resolveConfigSource(options: TestaMiddlewareOptions, projectId: string): ConfigSource {
  if (options.config || options.loadConfig || options.configUrl) return options;
  const host = (options.host ?? readEnv('TESTA_CONFIG_HOST') ?? DEFAULT_CONFIG_HOST).replace(
    /\/+$/,
    '',
  );
  return { ...options, configUrl: `${host}/api/v1/config/${projectId}` };
}

function readEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}
