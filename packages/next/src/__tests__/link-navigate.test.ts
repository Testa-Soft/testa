// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextLinkNavigate, readNextBasePath } from '../link-navigate.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nextLinkNavigate', () => {
  it('pushes the path through the Next router', () => {
    const push = vi.fn();
    nextLinkNavigate(push)('/pricing?plan=pro#top');
    expect(push).toHaveBeenCalledWith('/pricing?plan=pro#top');
  });

  it('strips basePath, which router.push adds back itself', () => {
    const push = vi.fn();
    const go = nextLinkNavigate(push, '/shop');
    go('/shop/pricing');
    go('/shop');
    go('/shop?x=1');
    expect(push.mock.calls).toEqual([['/pricing'], ['/'], ['/?x=1']]);
  });

  it('does a full navigation for a same-origin path outside basePath (not this app)', () => {
    const push = vi.fn();
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    nextLinkNavigate(push, '/shop')('/shopping/cart');
    expect(push).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/shopping/cart');
  });

  it('logs a push failure that is not a cancellation', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    nextLinkNavigate(() => Promise.reject(new Error('chunk load failed')))('/pricing');
    await new Promise((r) => setTimeout(r, 0));
    expect(logged).toHaveBeenCalled();
  });

  it('stays quiet when Next cancels a push for a newer navigation', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cancelled = Object.assign(new Error('Route Cancelled'), { cancelled: true });
    nextLinkNavigate(() => Promise.reject(cancelled))('/pricing');
    await new Promise((r) => setTimeout(r, 0));
    expect(logged).not.toHaveBeenCalled();
  });

  it('swallows a rejected Pages-Router push (no unhandled rejection)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const push = vi.fn(() => Promise.reject(new Error('Route Cancelled')));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    nextLinkNavigate(push)('/pricing');
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('readNextBasePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the basePath Next inlines into client bundles', () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '/shop');
    expect(readNextBasePath()).toBe('/shop');
  });

  it('is empty when the app has no basePath', () => {
    vi.stubEnv('__NEXT_ROUTER_BASEPATH', '');
    expect(readNextBasePath()).toBe('');
  });
});
