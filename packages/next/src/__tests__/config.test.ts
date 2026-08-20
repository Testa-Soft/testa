import { describe, expect, it, vi } from 'vitest';
import { ConfigClient } from '../config.ts';
import { splitUrlConfig } from './helpers.ts';

describe('ConfigClient', () => {
  it('returns static config without caching or fetching', async () => {
    const config = splitUrlConfig();
    const client = new ConfigClient({ config });
    expect(await client.get('acme', 0)).toBe(config);
    expect(await client.get('acme', 10_000_000)).toBe(config);
  });

  it('caches loadConfig results within the revalidate window', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    await client.get('acme', 0);
    await client.get('acme', 500); // within window → cached
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it('stale-while-revalidate: serves the stale config instantly, refreshes in the background', async () => {
    let version = 0;
    const loadConfig = vi.fn(async () => {
      version += 1;
      return { ...splitUrlConfig(), config_hash: `v${version}` };
    });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    const first = await client.get('acme', 0);
    expect(first?.config_hash).toBe('v1');

    // Past the window: the call must NOT block on the refetch — it returns the
    // stale entry and kicks the refresh in the background.
    const stale = await client.get('acme', 1500);
    expect(stale?.config_hash).toBe('v1');
    expect(loadConfig).toHaveBeenCalledTimes(2); // refresh started

    await vi.waitFor(async () => {
      const next = await client.get('acme', 1600);
      expect(next?.config_hash).toBe('v2');
    });
    expect(loadConfig).toHaveBeenCalledTimes(2); // refresh not duplicated
  });

  it('dedupes concurrent background refreshes', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const loadConfig = vi.fn(async () => {
      await gate;
      return splitUrlConfig();
    });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    const cold = client.get('acme', 0);
    release?.();
    await cold;
    expect(loadConfig).toHaveBeenCalledTimes(1);

    // Two stale hits while a refresh is already inflight → ONE refetch.
    await client.get('acme', 1500);
    await client.get('acme', 1501);
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the stale config when a background refresh fails', async () => {
    const good = splitUrlConfig();
    const loadConfig = vi
      .fn(async () => good)
      .mockImplementationOnce(async () => good)
      .mockImplementationOnce(async () => {
        throw new Error('config host down');
      });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    await client.get('acme', 0);
    const stale = await client.get('acme', 1500); // triggers failing refresh
    expect(stale).toBe(good);

    await vi.waitFor(async () => {
      // Still the good config — a failed refresh never clears the cache.
      expect(await client.get('acme', 1600)).toBe(good);
    });
  });

  it('passes the background refresh to waitUntil when provided', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });
    const waitUntil = vi.fn();

    await client.get('acme', 0, waitUntil);
    expect(waitUntil).not.toHaveBeenCalled(); // cold fetch is awaited, not deferred

    await client.get('acme', 1500, waitUntil);
    expect(waitUntil).toHaveBeenCalledTimes(1); // stale refresh rides waitUntil
  });

  it('caches per slug independently', async () => {
    const loadConfig = vi.fn(async (slug: string) =>
      splitUrlConfig({ from: `https://${slug}.com/a` }),
    );
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });
    await client.get('acme', 0);
    await client.get('other', 0);
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it('rejects cache: false at construction — an uncached blocking fetch per request is never valid', () => {
    const loadConfig = async () => splitUrlConfig();
    // Removed pre-1.1.0: it added a blocking config fetch to EVERY matched
    // request (documents, soft navs, prefetches) with no last-known fallback.
    expect(
      () => new ConfigClient({ loadConfig, cache: false as unknown as 'per-pageload' }),
    ).toThrow(/per-pageload/);
  });

  it('blocks on a refetch past the max-stale bound (5 min) instead of serving ancient config', async () => {
    let version = 0;
    const loadConfig = vi.fn(async () => {
      version += 1;
      return { ...splitUrlConfig(), config_hash: `v${version}` };
    });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    await client.get('acme', 0);
    const past = await client.get('acme', 400_000); // > 5 min old
    expect(past?.config_hash).toBe('v2'); // fetched fresh, not served stale
  });

  it('returns null when no source resolves', async () => {
    const client = new ConfigClient({ loadConfig: async () => null });
    expect(await client.get('acme', 0)).toBeNull();
  });

  it('fails open (null) when a configUrl fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new ConfigClient({ configUrl: 'https://cdn.example/acme.json' });
    expect(await client.get('acme', 0)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("ConfigClient — cache: 'per-pageload'", () => {
  it('fetches fresh on every document request, reuses it for soft navs', async () => {
    let version = 0;
    const loadConfig = vi.fn(async () => {
      version += 1;
      return { ...splitUrlConfig(), config_hash: `v${version}` };
    });
    const client = new ConfigClient({ loadConfig, cache: 'per-pageload' });

    // Hard load #1 → fresh fetch.
    expect((await client.get('acme', 0, undefined, true))?.config_hash).toBe('v1');
    // Soft navs → pinned to the hard load's copy, no matter how much later.
    expect((await client.get('acme', 900_000, undefined, false))?.config_hash).toBe('v1');
    expect(loadConfig).toHaveBeenCalledTimes(1);
    // Hard load #2 → fresh again (no cache between hard reloads).
    expect((await client.get('acme', 900_001, undefined, true))?.config_hash).toBe('v2');
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });

  it('cold-instance soft nav fetches once, then stays pinned', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig, cache: 'per-pageload' });
    await client.get('acme', 0, undefined, false);
    await client.get('acme', 1, undefined, false);
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it('a failed document fetch fails open to the last-known config', async () => {
    const good = splitUrlConfig();
    const loadConfig = vi
      .fn(async (): Promise<typeof good | null> => good)
      .mockImplementationOnce(async () => good)
      .mockImplementationOnce(async () => null);
    const client = new ConfigClient({ loadConfig, cache: 'per-pageload' });

    await client.get('acme', 0, undefined, true);
    expect(await client.get('acme', 1, undefined, true)).toBe(good);
  });
});
