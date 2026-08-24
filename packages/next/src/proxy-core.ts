/**
 * The proxy's decision pipeline — SYNCHRONOUS and `next/server`-free.
 *
 * Both proxy flavors (`createTestaProxy` / `createTestaProxySync`) are thin
 * executors around this module: they differ ONLY in how the config is acquired
 * (awaited fetch vs. sync snapshot/cache read) and in how the customer handler
 * is delegated (async vs. sync). Everything semantic — speculative-load
 * handling, bucketing, exposure/hook firing, redirect vs. shield decisions,
 * debug traces — lives here ONCE, so the two proxies cannot drift.
 *
 * The module is typed against structural request shapes (`ProxyRequest`), not
 * `NextRequest`, keeping it unit-testable and free of edge-only imports.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  ASSIGNMENT_COOKIE,
  UUID_COOKIE,
  type VariationAppliedEvent,
  hasPendingDomChange,
  runExperiments,
} from '@testa-soft/experiment-core';
import { DEFAULT_TRACKING_HOST, SHIELD_HEADER, readEnv } from './constants.ts';
import { type ReadableCookies, NextCookieStore } from './cookie-store.ts';
import type { DebugTrace } from './debug.ts';
import { resolveCookieDomain } from './domain.ts';
import { computePrefetchRedirect } from './soft-nav/prefetch-guard.ts';
import { isPrefetchRequest } from './soft-nav/rsc-redirect.ts';
import { emitExposure } from './tracking.ts';
import {
  type PublicHostOption,
  type PublicUrlSource,
  resolvePublicUrlDetailed,
} from './url-resolver.ts';
import { ensureVisitorId } from './uuid.ts';

/** Structural subset of `NextRequest` the pipeline needs. */
export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly cookies: ReadableCookies;
}

/** Context passed to `onVariationAssigned` — keep an async task alive past the response. */
export interface VariationHookContext {
  /** Run `promise` to completion after the response is sent (never delays it). */
  waitUntil: (promise: Promise<unknown>) => void;
}

export type VariationAssignedListener = (
  event: VariationAppliedEvent,
  ctx: VariationHookContext,
) => void | Promise<void>;

/** The per-instance settings both proxy flavors resolve once at creation. */
export interface ProxyPipeline<TReq extends ProxyRequest = ProxyRequest> {
  readonly secure: boolean;
  readonly trackingEnabled: boolean;
  readonly trackingHost: string;
  readonly skipBots: boolean;
  readonly publicHost: PublicHostOption<TReq> | undefined;
  readonly cookieDomain: string | undefined;
  readonly discoverRootDomain: boolean;
  readonly sessionLengthSec: number | undefined;
  readonly onVariationAssigned: VariationAssignedListener | undefined;
}

/** Option subset the pipeline needs — structurally satisfied by TestaProxyOptions. */
export interface ProxyPipelineOptions<TReq extends ProxyRequest = ProxyRequest> {
  secureCookies?: boolean;
  tracking?: boolean;
  trackingHost?: string;
  skipBots?: boolean;
  publicHost?: PublicHostOption<TReq>;
  cookieDomain?: string;
  discoverRootDomain?: boolean;
  sessionLengthSec?: number;
  onVariationAssigned?: VariationAssignedListener;
}

export function resolveProxyPipeline<TReq extends ProxyRequest>(
  options: ProxyPipelineOptions<TReq>,
): ProxyPipeline<TReq> {
  return {
    secure: options.secureCookies ?? true,
    trackingEnabled: options.tracking ?? true,
    trackingHost: (
      options.trackingHost ??
      readEnv('TESTA_TRACKING_HOST') ??
      DEFAULT_TRACKING_HOST
    ).replace(/\/+$/, ''),
    skipBots: options.skipBots ?? true,
    publicHost: options.publicHost ?? readEnv('TESTA_PUBLIC_HOST'),
    cookieDomain: options.cookieDomain,
    discoverRootDomain: options.discoverRootDomain ?? false,
    sessionLengthSec: options.sessionLengthSec,
    onVariationAssigned: options.onVariationAssigned,
  };
}

/** Public-URL + cookie-store preparation, shared verbatim by both proxies. */
export interface PreparedRequest {
  readonly publicUrl: URL;
  readonly urlSource: PublicUrlSource;
  readonly store: NextCookieStore;
}

export function prepareProxyRequest<TReq extends ProxyRequest>(
  req: TReq,
  pipeline: ProxyPipeline<TReq>,
): PreparedRequest {
  // The URL the VISITOR requested — `req.url` can carry an internal host on
  // self-hosted container/ingress stacks (istio et al. rewrite `Host`), which
  // would break split-URL targeting, cookie discovery, and redirect bases.
  const { url: publicUrl, source: urlSource } = resolvePublicUrlDetailed(req, pipeline.publicHost);
  const cookieDomain = resolveCookieDomain(publicUrl.hostname, {
    ...(pipeline.cookieDomain ? { cookieDomain: pipeline.cookieDomain } : {}),
    ...(pipeline.discoverRootDomain ? { discoverRootDomain: true } : {}),
  });
  const store = new NextCookieStore(req.cookies, {
    secure: pipeline.secure,
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
  return { publicUrl, urlSource, store };
}

/**
 * What the executor must do with the request. `delegate` = run the customer
 * handler / pass through untouched; `redirect` carries whether the cookie
 * store commits (speculative redirects never do); `pass` carries the request
 * headers with the shield verdict already set.
 */
export type ProxyDecision =
  | { kind: 'delegate'; debug: DebugTrace }
  | { kind: 'redirect'; location: URL; commit: boolean; debug: DebugTrace }
  | { kind: 'pass'; requestHeaders: Headers; debug: DebugTrace };

export interface DecideProxyRequestInput<TReq extends ProxyRequest = ProxyRequest> {
  readonly req: TReq;
  readonly config: ProjectConfig;
  readonly prepared: PreparedRequest;
  readonly pipeline: ProxyPipeline<TReq>;
  readonly now: number;
  /** Normalized keep-alive (see `makeWaitUntil`) for exposures/hooks/refreshes. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export function decideProxyRequest<TReq extends ProxyRequest>(
  input: DecideProxyRequestInput<TReq>,
): ProxyDecision {
  const { req, config, pipeline, now, waitUntil } = input;
  const { publicUrl, urlSource, store } = input.prepared;
  const userAgent = req.headers.get('user-agent');
  const country = geoCountry(req);

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
        now,
        getCookie: (name) => store.get(name),
        ...(userAgent ? { userAgent } : {}),
        ...(country ? { country } : {}),
      },
      store, // written into by the engine, then intentionally discarded (no applyTo)
    );
    const debug: DebugTrace = { url: publicUrl.href, urlSource, speculative };
    if (redirectTo) {
      return {
        kind: 'redirect',
        location: new URL(redirectTo, publicUrl),
        commit: false,
        debug: { ...debug, redirect: redirectTo },
      };
    }
    return { kind: 'delegate', debug };
  }

  const visitorId = ensureVisitorId(store);
  const result = runExperiments(
    {
      config,
      currentUrl: publicUrl.href,
      visitorId,
      now,
      getCookie: (name) => store.get(name),
      ...(userAgent ? { userAgent } : {}),
      ...(country ? { country } : {}),
      ...(pipeline.sessionLengthSec !== undefined
        ? { sessionLengthSec: pipeline.sessionLengthSec }
        : {}),
    },
    store,
  );

  for (const applied of result.applied) {
    fireVariationAssigned(pipeline.onVariationAssigned, applied, waitUntil);
    // Emit an exposure once per fresh enrollment (deduped server-side anyway).
    if (pipeline.trackingEnabled && applied.firstAssignment && config.project_id != null) {
      waitUntil(
        emitExposure(pipeline.trackingHost, {
          project_id: config.project_id,
          experiment: applied.experimentId,
          variation: applied.variationId,
          uuid: applied.visitorId,
          ...(applied.title ? { title: applied.title } : {}),
          url: applied.url,
        }),
      );
    }
  }

  const debugBase: DebugTrace = {
    url: publicUrl.href,
    urlSource,
    visitor: visitorId,
    ...(config.config_hash != null ? { configHash: config.config_hash } : {}),
    applied: summarizeApplied(result.applied),
  };

  if (result.redirectTo) {
    return {
      kind: 'redirect',
      location: new URL(result.redirectTo, publicUrl),
      commit: true,
      debug: { ...debugBase, redirect: result.redirectTo },
    };
  }

  // Tell the app whether to raise the anti-flicker shield for THIS request:
  // only when the visitor has a pending DOM change on this page. Split-URL-only
  // projects and pages with nothing to change get `0`, so `<TestaGuard/>`
  // never overlays needlessly. Passed as a request header the RSC layout reads
  // via `headers()`. Runs on soft-nav RSC requests too, so it stays per-page.
  const shield = hasPendingDomChange(config, publicUrl.href, store.get(ASSIGNMENT_COOKIE));
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(SHIELD_HEADER, shield ? '1' : '0');
  return { kind: 'pass', requestHeaders, debug: { ...debugBase, shield } };
}

/**
 * Normalize the fetch event's `waitUntil` into an always-callable keep-alive:
 * with an event the promise outlives the response; without one it is
 * fire-and-forget. Rejections are swallowed either way — background work never
 * breaks a request.
 */
export function makeWaitUntil(
  event: { waitUntil?: (promise: Promise<unknown>) => void } | undefined,
): (promise: Promise<unknown>) => void {
  return (promise) => {
    const safe = promise.catch(() => undefined);
    if (event?.waitUntil) event.waitUntil(safe);
  };
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

/** Invoke the hook without ever letting it break the request; keep async work alive. */
function fireVariationAssigned(
  listener: VariationAssignedListener | undefined,
  event: VariationAppliedEvent,
  waitUntil: (promise: Promise<unknown>) => void,
): void {
  if (!listener) return;
  try {
    const r = listener(event, { waitUntil });
    // If the hook itself returned a promise, keep the worker alive for it too.
    if (r && typeof (r as Promise<void>).then === 'function') waitUntil(r as Promise<void>);
  } catch {
    // never break the request on a hook error
  }
}

/** Best-effort ISO country from common edge geo headers (Vercel / Cloudflare). */
function geoCountry(req: ProxyRequest): string | undefined {
  return req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry') ?? undefined;
}
