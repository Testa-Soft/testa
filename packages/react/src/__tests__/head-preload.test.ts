/**
 * The `<head>` config preload — `preloadConfig` must ADOPT the fetch the head
 * snippet already started, not race it with a second one.
 *
 * This is what makes the client fast enough to own a cold-start redirect: the
 * request begins during HTML parse, in parallel with the framework bundle,
 * instead of after hydration reaches the provider.
 */

import { CONFIG_PROMISE_KEY } from '@testa-soft/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetPreloadCacheForTests, preloadConfig } from '../config.ts';
import { splitUrlConfig } from './helpers.ts';

const host = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  delete host[CONFIG_PROMISE_KEY];
  __resetPreloadCacheForTests();
  vi.unstubAllGlobals();
});

describe('head-started config fetch', () => {
  it('adopts the in-flight promise instead of fetching again', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn();
    host[CONFIG_PROMISE_KEY] = Promise.resolve(config);

    const resolved = await preloadConfig({ projectId: 'acme' }, { fetchImpl: fetchImpl as never });

    expect(resolved).toBe(config);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes it once — a later call does not re-read a now-aged body', async () => {
    const early = splitUrlConfig({ from: 'https://acme.com/early' });
    const fresh = splitUrlConfig({ from: 'https://acme.com/fresh' });
    host[CONFIG_PROMISE_KEY] = Promise.resolve(early);
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => fresh }) as Response);

    expect(await preloadConfig({ projectId: 'acme' }, { fetchImpl })).toBe(early);
    __resetPreloadCacheForTests(); // simulate a later, past-TTL call
    expect(await preloadConfig({ projectId: 'acme' }, { fetchImpl })).toEqual(fresh);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a normal fetch when the head fetch failed', async () => {
    const config = splitUrlConfig();
    host[CONFIG_PROMISE_KEY] = Promise.resolve(null); // snippet fetch failed
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => config }) as Response);

    expect(await preloadConfig({ projectId: 'acme' }, { fetchImpl })).toEqual(config);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
