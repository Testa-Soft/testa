/**
 * `createTestaProxySync` — the never-awaits proxy flavor.
 *
 * A SYNC executor around the same decision pipeline (`proxy-core.ts`) that
 * powers `createTestaProxy`, for customers whose middleware is synchronous and
 * must stay that way: it slots into an existing sync `proxy.ts` at any position
 * (`const res = testaProxy(req, event)`) without forcing `async` through their
 * code. Follows the feature-flag-SDK convention (Unleash, Statsig, GrowthBook):
 * evaluate synchronously, refresh config in the background.
 *
 * Config comes from, in order: a static `config` object, the instrumentation
 * poller's snapshot (`registerTestaConfig` in the app's instrumentation.ts —
 * requires the Node middleware runtime to be visible here), or the SWR cache's
 * last-known-good entry. What it can NEVER do is fetch inline — a cold
 * fetch-based instance therefore passes requests through UNEXPERIMENTED while
 * a background fetch (kept alive via `event.waitUntil`) warms the cache for
 * the next request. Pair it with the poller or a static config for full
 * fidelity from the first request; use `createTestaProxy` when one cold
 * blocking fetch is preferable to those first unexperimented requests.
 *
 * The `handler` option is typed — and enforced at runtime — as synchronous: a
 * handler returning a Promise cannot be awaited here, so it throws with a
 * pointer to `createTestaProxy` instead of silently dropping the response.
 */

import { NextRequest, NextResponse } from 'next/server.js';
import type { NextFetchEvent } from 'next/server.js';
import { isCrawlerUserAgent } from './bot.ts';
import { applyRequestHeaders, isRedirect, toNextResponse } from './compose.ts';
import { ConfigClient } from './config.ts';
import { SHIELD_HEADER, readEnv } from './constants.ts';
import { createDebugEmitter, envDebugEnabled } from './debug.ts';
import {
  type TestaProxyOptions,
  resolveConfigSource,
} from './middleware.ts';
import {
  decideProxyRequest,
  makeWaitUntil,
  prepareProxyRequest,
  resolveProxyPipeline,
} from './proxy-core.ts';
import { isDocumentMethod, shouldBypassRequest } from './request-filter.ts';

/**
 * Customer middleware logic composed inside the SYNC proxy — same contract as
 * `TestaHandler`, minus promises (see `handler` on `TestaProxyOptions`).
 */
export type TestaSyncHandler = (
  req: NextRequest,
  event?: NextFetchEvent,
) => Response | null | undefined;

export interface TestaProxySyncOptions extends Omit<TestaProxyOptions, 'handler'> {
  /** Sync-only composed handler — an async handler needs `createTestaProxy`. */
  handler?: TestaSyncHandler;
}

export type TestaProxySync = (req: NextRequest, event?: NextFetchEvent) => NextResponse;

export function createTestaProxySync(options: TestaProxySyncOptions): TestaProxySync {
  const projectId = options.projectId ?? options.projectSlug;
  if (!projectId) {
    throw new Error('createTestaProxySync: `projectId` is required');
  }
  const configClient = new ConfigClient(resolveConfigSource(options, projectId));
  const pipeline = resolveProxyPipeline<NextRequest>(options);
  const emitDebug = createDebugEmitter(options.debug ?? envDebugEnabled(readEnv('TESTA_DEBUG')));

  return function testaMiddlewareSync(req: NextRequest, event?: NextFetchEvent): NextResponse {
    const waitUntil = makeWaitUntil(event);

    // Same blackbox safety net as the async proxy — see middleware.ts.
    if (
      !isDocumentMethod(req.method) ||
      shouldBypassRequest(new URL(req.url).pathname, options.skipPaths)
    ) {
      const res = delegateSync(options.handler, req, event);
      emitDebug?.(res, {
        url: req.url,
        bypass: isDocumentMethod(req.method) ? 'path' : 'method',
        method: req.method,
      });
      return res;
    }

    if (pipeline.skipBots && isCrawlerUserAgent(req.headers.get('user-agent'))) {
      const res = delegateSync(options.handler, req, event);
      emitDebug?.(res, { url: req.url, bypass: 'bot' });
      return res;
    }

    const prepared = prepareProxyRequest(req, pipeline);
    const config = configClient.getSync(projectId, Date.now(), waitUntil);

    // No config in memory (cold fetch-based instance) → pass through
    // unexperimented; getSync already kicked the background warm-up.
    if (!config) {
      const res = delegateSync(options.handler, req, event);
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
      const res = resolveDownstreamSync(options.handler, req, decision.requestHeaders, event);
      prepared.store.applyTo(res.cookies);
      emitDebug?.(res, decision.debug);
      return res;
    }

    const res = delegateSync(options.handler, req, event);
    emitDebug?.(res, decision.debug);
    return res;
  };
}

/** Sync twin of middleware.ts's `delegate` — same transparency contract. */
function delegateSync(
  handler: TestaSyncHandler | undefined,
  req: NextRequest,
  event: NextFetchEvent | undefined,
): NextResponse {
  const forward = (): NextResponse => NextResponse.next({ request: { headers: req.headers } });
  if (!handler) return forward();
  const out = rejectAsyncHandler(handler(req, event));
  const res = toNextResponse(out, forward);
  return isRedirect(res) ? res : applyRequestHeaders(res, {}, req);
}

/** Sync twin of middleware.ts's `resolveDownstream` — same shield contract. */
function resolveDownstreamSync(
  handler: TestaSyncHandler | undefined,
  req: NextRequest,
  requestHeaders: Headers,
  event: NextFetchEvent | undefined,
): NextResponse {
  if (!handler) return NextResponse.next({ request: { headers: requestHeaders } });
  const downstreamReq = new NextRequest(req, { headers: requestHeaders });
  const out = rejectAsyncHandler(handler(downstreamReq, event));
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
 * A sync proxy cannot await a handler's promise, and silently treating it as
 * "no response" would drop the customer's redirect/headers — loud beats wrong.
 */
function rejectAsyncHandler(
  out: Response | null | undefined | Promise<unknown>,
): Response | null | undefined {
  if (out && typeof (out as Promise<unknown>).then === 'function') {
    throw new Error(
      'createTestaProxySync: the composed `handler` returned a Promise — a sync ' +
        'proxy cannot await it. Make the handler synchronous, or use createTestaProxy.',
    );
  }
  return out as Response | null | undefined;
}
