// @vitest-environment happy-dom
/**
 * Soft-nav M2 (task N.6) — `<TestaRouterGuard/>` logic: cookie-first assignment
 * resolution + the routeChangeStart controller. The React component is thin glue
 * over these (validated end-to-end in the demo, N.7), so it isn't rendered here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import {
  type GuardRouter,
  ROUTE_ABORT,
  installRouterGuard,
  resolveGuardRedirect,
  sameOriginPath,
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

  it('returns null for a page the experiment does not target', () => {
    // Without the page-rule gate this hijacked EVERY navigation: an exact-mode
    // destination ignores where the visitor currently is, so an assigned
    // visitor got sent to the variant URL from any page on the site.
    expect(
      resolveGuardRedirect({
        config,
        currentUrl: 'https://acme.com/blog/hello',
        cookieValue: '101.2.0.0',
      }),
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

/** Install and remember the unsubscribe — a leaked guard keeps a window listener. */
const installed: Array<() => void> = [];
function install(router: GuardRouter, guardDeps: Parameters<typeof installRouterGuard>[1]) {
  const off = installRouterGuard(router, guardDeps);
  installed.push(off);
  return off;
}

afterEach(() => {
  for (const off of installed.splice(0)) off();
});

const deps = () => ({
  config,
  getCookieValue: () => '101.2.0.0' as string | null,
  toAbsoluteUrl: (path: string) => new URL(path, 'https://acme.com').href,
});

describe('installRouterGuard — routeChangeStart', () => {
  it('replaces to the variant and aborts on a control-URL nav for an assigned visitor', () => {
    const router = fakeRouter();
    install(router, deps());
    expect(() => router.fire('/pricing')).toThrow(ROUTE_ABORT);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.calls[0]?.[0]).toContain('/pricing-v2');
  });

  it('lets navigation proceed (no replace, no throw) when there is no match', () => {
    const router = fakeRouter();
    install(router, { ...deps(), getCookieValue: () => null });
    expect(() => router.fire('/pricing')).not.toThrow();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const router = fakeRouter();
    const off = install(router, deps());
    off();
    expect(router.handlers).toHaveLength(0);
    expect(() => router.fire('/pricing')).not.toThrow();
  });

  it('hands the router a PATH, never an absolute URL', () => {
    // An absolute URL makes Next resolve it against the current route and merge
    // that route's interpolated params into the query — `/question/female/1`
    // arrives carrying `?gender=male&step=1`.
    const router = fakeRouter();
    install(router, deps());
    expect(() => router.fire('/pricing')).toThrow(ROUTE_ABORT);
    const passed = router.replace.mock.calls[0]?.[0] as string;
    expect(passed.startsWith('/')).toBe(true);
    expect(passed).not.toContain('https://');
  });

  it('throws a cancelled Error, which is what Next swallows', () => {
    // `router.change` checks `isError(err) && err.cancelled` on every failure
    // path. A thrown string escapes and shows up as an unhandled rejection in
    // the console on every single redirect.
    const router = fakeRouter();
    install(router, deps());
    try {
      router.fire('/pricing');
      throw new Error('expected the guard to abort');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { cancelled?: boolean }).cancelled).toBe(true);
      expect((err as Error).message).toBe(ROUTE_ABORT);
    }
  });

  it('leaves the origin through `navigate` for a cross-domain variant', () => {
    const crossDomain = {
      ...config,
      experiments: config.experiments.map((experiment) => ({
        ...experiment,
        variations: experiment.variations.map((variation) => ({
          ...variation,
          changes: variation.changes.map((change) =>
            change.type === 'redirect'
              ? { ...change, to_url: 'https://variant.example/pricing-v2' }
              : change,
          ),
        })),
      })),
    };
    const router = fakeRouter();
    const navigate = vi.fn();
    install(router, { ...deps(), config: crossDomain, navigate });
    expect(() => router.fire('/pricing')).toThrow(ROUTE_ABORT);
    expect(router.replace).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('https://variant.example/pricing-v2');
  });
});

describe('sameOriginPath', () => {
  it('reduces a same-origin absolute URL to path + query + hash', () => {
    expect(sameOriginPath('https://acme.com/a/b?x=1#f', 'https://acme.com/c')).toBe('/a/b?x=1#f');
  });

  it('returns null for another origin — the router cannot route there', () => {
    expect(sameOriginPath('https://other.com/a', 'https://acme.com/c')).toBeNull();
  });

  it('passes a relative destination through unchanged', () => {
    expect(sameOriginPath('/a?x=1', 'https://acme.com/c')).toBe('/a?x=1');
  });
});

describe('the abort rejection', () => {
  /** Fire a real `unhandledrejection` and report whether it was suppressed. */
  function rejectWith(reason: unknown): boolean {
    // Cancelable, like the real one — otherwise preventDefault is a no-op.
    const event = new Event('unhandledrejection', { cancelable: true }) as Event & {
      reason: unknown;
    };
    event.reason = reason;
    return !window.dispatchEvent(event); // dispatchEvent returns false once prevented
  }

  it("suppresses only our own abort, never the host app's rejections", () => {
    const router = fakeRouter();
    const off = install(router, deps());

    expect(rejectWith(new Error(ROUTE_ABORT))).toBe(true);
    expect(rejectWith(ROUTE_ABORT)).toBe(true);
    expect(rejectWith(new Error('the app broke'))).toBe(false);
    expect(rejectWith(undefined)).toBe(false);

    off();
    // Unsubscribed: no longer our business.
    expect(rejectWith(new Error(ROUTE_ABORT))).toBe(false);
  });
});
