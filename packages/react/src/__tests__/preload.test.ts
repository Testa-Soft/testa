import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetPreloadCacheForTests, preloadConfig } from '../config.ts';
import { splitUrlConfig } from './helpers.ts';

afterEach(() => {
  __resetPreloadCacheForTests();
  vi.restoreAllMocks();
});

/** A fetchImpl that returns the given config as a 200 JSON response. */
function okFetch(config = splitUrlConfig()): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(config), { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('preloadConfig', () => {
  it('short-circuits an inline config without fetching', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await preloadConfig({ config }, { fetchImpl })).toBe(config);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dedupes concurrent calls for the same source into ONE fetch', async () => {
    const fetchImpl = okFetch();
    const source = { projectId: 'acme' };
    const [a, b, c] = await Promise.all([
      preloadConfig(source, { fetchImpl }),
      preloadConfig(source, { fetchImpl }),
      preloadConfig(source, { fetchImpl }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ slug: 'acme' });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('reuses a settled result within the TTL, refetches past it', async () => {
    const fetchImpl = okFetch();
    let clock = 1000;
    const now = () => clock;
    const source = { projectId: 'acme', cacheTtlMs: 5000 };

    await preloadConfig(source, { fetchImpl, now });
    clock = 3000; // within TTL → cached
    await preloadConfig(source, { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 7000; // past TTL → refetch
    await preloadConfig(source, { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('resolves null on fetch failure without throwing, and does not poison forever', async () => {
    let clock = 0;
    const now = () => clock;
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(
      await preloadConfig({ projectId: 'acme', cacheTtlMs: 100 }, { fetchImpl: failing, now }),
    ).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);

    // Past the TTL a recovered network refetches and succeeds.
    clock = 500;
    const recovered = okFetch();
    const result = await preloadConfig(
      { projectId: 'acme', cacheTtlMs: 100 },
      { fetchImpl: recovered, now },
    );
    expect(result).toMatchObject({ slug: 'acme' });
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('resolves null when no source is resolvable', async () => {
    expect(await preloadConfig({})).toBeNull();
  });

  it('never fetches without a document — a render pass on the server must not', () => {
    // `preloadConfig` is called from a useState initializer, so it runs during
    // SSR too. Nothing can consume the result there, and the fetch would be a
    // config request the server pays for and throws away.
    const fetchImpl = vi.fn();
    const doc = globalThis.document;
    // @ts-expect-error — simulating a server render
    globalThis.document = undefined;
    try {
      const promise = preloadConfig({ projectId: 'acme' }, { fetchImpl: fetchImpl as never });
      expect(fetchImpl).not.toHaveBeenCalled();
      return expect(promise).resolves.toBeNull();
    } finally {
      globalThis.document = doc;
    }
  });
});
