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

  it('caches loadConfig results within the TTL, then refreshes', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    await client.get('acme', 0);
    await client.get('acme', 500); // within TTL → cached
    expect(loadConfig).toHaveBeenCalledTimes(1);

    await client.get('acme', 1500); // past TTL → refetch
    expect(loadConfig).toHaveBeenCalledTimes(2);
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
