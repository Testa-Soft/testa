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

    // Cold: never blocks on the network — defers this request to the client
    // and warms the cache in the background.
    const cold = await client.get('acme', 0);
    expect(cold).toBeNull();
    await vi.waitFor(async () => {
      expect((await client.get('acme', 0))?.config_hash).toBe('v1');
    });

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

    // Cold returns null immediately (deferred to the client) and warms behind it.
    expect(await client.get('acme', 0)).toBeNull();
    release?.();
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await client.get('acme', 0)).not.toBeNull());

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

    expect(await client.get('acme', 0)).toBeNull(); // cold → deferred, warms behind
    await vi.waitFor(async () => expect(await client.get('acme', 0)).toBe(good));
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

    // The cold warm-up is itself a background refresh now — it must ride
    // waitUntil, or a serverless host can kill it before it populates.
    await client.get('acme', 0, waitUntil);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await client.get('acme', 0)).not.toBeNull());

    await client.get('acme', 1500, waitUntil);
    expect(waitUntil).toHaveBeenCalledTimes(2); // stale refresh rides waitUntil too
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

  it('defers to the client past the max-stale bound rather than serving ancient config', async () => {
    let version = 0;
    const loadConfig = vi.fn(async () => {
      version += 1;
      return { ...splitUrlConfig(), config_hash: `v${version}` };
    });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    await client.get('acme', 0);
    await vi.waitFor(async () => expect(await client.get('acme', 0)).not.toBeNull());

    // Within the bound the stale entry is still served (assignment is
    // cookie-pinned, so an old config cannot move anyone between variations).
    expect((await client.get('acme', 800_000))?.config_hash).toBe('v1');

    // Past it, refreshes are evidently failing to keep up — hand the pageview
    // to the client, which fetches for itself, instead of acting on a config
    // this old. Still NEVER blocks.
    expect(await client.get('acme', 2_000_000)).toBeNull();
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
