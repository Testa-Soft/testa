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

import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';
import { SHIELD_HEADER } from '../constants.ts';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

const request = (url: string) => new NextRequest(new URL(url));

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

    const cold = await proxy(request('https://acme.com/pricing'));
    expect(cold.status).toBe(200); // deferred — no 307 yet

    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    await vi.waitFor(async () => {
      const hot = await proxy(request('https://acme.com/pricing'));
      expect(hot.status).toBe(307);
    });
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
