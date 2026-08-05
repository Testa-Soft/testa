/**
 * Soft-nav M2 (task N.6) — `<TestaRouterGuard/>` logic: cookie-first assignment
 * resolution + the routeChangeStart controller. The React component is thin glue
 * over these (validated end-to-end in the demo, N.7), so it isn't rendered here.
 */

import { describe, expect, it, vi } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import {
  type GuardRouter,
  ROUTE_ABORT,
  installRouterGuard,
  resolveGuardRedirect,
} from '../use-cookie-assignment.ts';

const config = splitUrlConfig();
const CONTROL = 'https://acme.com/pricing';

describe('resolveGuardRedirect — cookie-first', () => {
  it('returns the variant URL for a visitor assigned to the redirect variant', () => {
    const to = resolveGuardRedirect({ config, currentUrl: CONTROL, cookieValue: '101.2.0.0' });
    expect(to).toContain('/pricing-v2');
  });

  it('returns null with no assignment cookie (never re-buckets)', () => {
    expect(resolveGuardRedirect({ config, currentUrl: CONTROL, cookieValue: null })).toBeNull();
  });

  it('returns null for a control-assigned visitor (variation has no redirect)', () => {
    expect(
      resolveGuardRedirect({ config, currentUrl: CONTROL, cookieValue: '101.1.0.0' }),
    ).toBeNull();
  });

  it('returns null when already at the variant URL (no loop)', () => {
    expect(
      resolveGuardRedirect({
        config,
        currentUrl: 'https://acme.com/pricing-v2',
        cookieValue: '101.2.0.0',
      }),
    ).toBeNull();
  });
});

function fakeRouter(): GuardRouter & {
  fire(path: string): void;
  replace: ReturnType<typeof vi.fn>;
  handlers: Array<(url: string) => void>;
} {
  const handlers: Array<(url: string) => void> = [];
  const replace = vi.fn();
  return {
    handlers,
    replace,
    events: {
      on: (_e, h) => handlers.push(h),
      off: (_e, h) => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      },
    },
    fire(path: string) {
      for (const h of [...handlers]) h(path);
    },
  };
}

const deps = () => ({
  config,
  getCookieValue: () => '101.2.0.0' as string | null,
  toAbsoluteUrl: (path: string) => new URL(path, 'https://acme.com').href,
});

describe('installRouterGuard — routeChangeStart', () => {
  it('replaces to the variant and aborts on a control-URL nav for an assigned visitor', () => {
    const router = fakeRouter();
    installRouterGuard(router, deps());
    expect(() => router.fire('/pricing')).toThrow(ROUTE_ABORT);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.calls[0]?.[0]).toContain('/pricing-v2');
  });

  it('lets navigation proceed (no replace, no throw) when there is no match', () => {
    const router = fakeRouter();
    installRouterGuard(router, { ...deps(), getCookieValue: () => null });
    expect(() => router.fire('/pricing')).not.toThrow();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const router = fakeRouter();
    const off = installRouterGuard(router, deps());
    off();
    expect(router.handlers).toHaveLength(0);
    expect(() => router.fire('/pricing')).not.toThrow();
  });
});
