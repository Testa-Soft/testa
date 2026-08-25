/**
 * Cold-start behaviour: the proxy never blocks a request on the network, and
 * hands the pageview to the client engine with the anti-flicker shield RAISED.
 *
 * The shield is the load-bearing part. On a cold instance the client is the one
 * that redirects (or applies DOM changes), which happens after hydration — so
 * without a shield the visitor sees the control page first. The proxy cannot
 * know whether this page has anything to hide (it has no config), so it must
 * shield pessimistically.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';
import { SHIELD_HEADER } from '../constants.ts';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

const request = (url: string) => new NextRequest(new URL(url));

/**
 * A request already assigned to the REDIRECT variation. The fixture is 50/50
 * and a cookie-less request mints a fresh visitor id, so bucketing would
 * otherwise be a coin flip; pinning the assignment makes "did the server
 * redirect?" deterministic (assign() is cookie-first).
 */
const assignedToVariant = (url: string) =>
  new NextRequest(new URL(url), {
    headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
  });

/** The shield verdict the app would read via `headers()` / `<TestaGuard/>`. */
function shieldHeaderSeenByApp(handlerSpy: ReturnType<typeof vi.fn>): string | null {
  const req = handlerSpy.mock.calls[0]?.[0] as NextRequest | undefined;
  return req?.headers.get(SHIELD_HEADER) ?? null;
}

describe('cold instance defers to the client', () => {
  it('does not block on the config fetch, and raises the shield', async () => {
    let resolveConfig: ((c: unknown) => void) | undefined;
    const loadConfig = vi.fn(
      () =>
        new Promise((r) => {
          resolveConfig = r as (c: unknown) => void;
        }),
    );
    const handler = vi.fn(() => NextResponse.next());
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: loadConfig as never,
      handler,
    });

    // Resolves while the config fetch is still pending — proof it never awaited.
    const res = await proxy(request('https://acme.com/pricing'));
    expect(res.status).toBe(200);
    expect(shieldHeaderSeenByApp(handler)).toBe('1');

    resolveConfig?.(splitUrlConfig());
  });

  it('warms the cache so the NEXT request gets the server-side redirect', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const proxy = createTestaProxy({ projectId: 'acme', loadConfig });

    const cold = await proxy(assignedToVariant('https://acme.com/pricing'));
    expect(cold.status).toBe(200); // deferred — no 307 yet, even though assigned

    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    await vi.waitFor(async () => {
      const hot = await proxy(assignedToVariant('https://acme.com/pricing'));
      expect(hot.status).toBe(307);
    });
  });

  it("decisions: 'server' — waits for the config so even the FIRST request redirects", async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const proxy = createTestaProxy({ projectId: 'acme', loadConfig, decisions: 'server' });

    const first = await proxy(assignedToVariant('https://acme.com/pricing'));
    expect(first.status).toBe(307); // server-side, on a cold instance
  });

  it("decisions: 'server' — the budget caps a hung resolver instead of stalling the request", async () => {
    // Never resolves: a hung origin, or a customer `loadConfig` (Edge Config,
    // KV) that wedges. The budget must cut the WAIT, not the request.
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: (() => new Promise(() => undefined)) as never,
      decisions: 'server',
      fetchTimeoutMs: 20,
    });

    const res = await proxy(request('https://acme.com/pricing'));
    expect(res.status).toBe(200); // proceeded without experiments — fail open
  });

  it("decisions: 'client' — never fetches at all", async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const handler = vi.fn(() => NextResponse.next());
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig,
      decisions: 'client',
      handler,
    });

    const res = await proxy(request('https://acme.com/pricing'));
    expect(res.status).toBe(200);
    expect(loadConfig).not.toHaveBeenCalled(); // no fetch, no background refresh
    expect(shieldHeaderSeenByApp(handler)).toBe('1'); // client owns it → shield up
  });

  it('still runs the customer handler while deferring', async () => {
    const handler = vi.fn(() => {
      const res = NextResponse.next();
      res.headers.set('x-customer', 'ran');
      return res;
    });
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: async () => null,
      handler,
    });

    const res = await proxy(request('https://acme.com/pricing'));
    expect(handler).toHaveBeenCalled();
    expect(res.headers.get('x-customer')).toBe('ran');
  });
});
