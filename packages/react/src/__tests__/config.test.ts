import { describe, expect, it, vi } from 'vitest';
import { ConfigClient, DEFAULT_CONFIG_HOST, resolveConfigUrl } from '../config.ts';
import { splitUrlConfig } from './helpers.ts';

describe('resolveConfigUrl', () => {
  it('prefers an explicit configUrl', () => {
    expect(resolveConfigUrl({ configUrl: 'https://x/cfg.json', projectId: 'acme' })).toBe(
      'https://x/cfg.json',
    );
  });

  it('builds from the default host + projectId', () => {
    expect(resolveConfigUrl({ projectId: 'acme' })).toBe(
      `${DEFAULT_CONFIG_HOST}/api/v1/config/acme`,
    );
  });

  it('honours a custom host (trailing slash trimmed)', () => {
    expect(resolveConfigUrl({ projectId: 'acme', host: 'https://staging.example.com/' })).toBe(
      'https://staging.example.com/api/v1/config/acme',
    );
  });

  it('returns null when nothing is resolvable', () => {
    expect(resolveConfigUrl({})).toBeNull();
  });
});

describe('ConfigClient', () => {
  it('returns an inline config without fetching', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new ConfigClient({ config });
    expect(await client.get(0, fetchImpl)).toBe(config);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches by projectId and caches within the TTL', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(config), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new ConfigClient({ projectId: 'acme', cacheTtlMs: 1000 });

    const first = await client.get(0, fetchImpl);
    expect(first).toMatchObject({ slug: 'acme' });
    // Second call within TTL → served from cache, no re-fetch.
    await client.get(500, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // After TTL → re-fetch.
    await client.get(2000, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null (fail open) on a non-ok response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch;
    const client = new ConfigClient({ projectId: 'acme' });
    expect(await client.get(0, fetchImpl)).toBeNull();
  });

  it('returns null (fail open) on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const client = new ConfigClient({ projectId: 'acme' });
    expect(await client.get(0, fetchImpl)).toBeNull();
  });

  it('returns null when no source is resolvable', async () => {
    const client = new ConfigClient({});
    expect(await client.get(0)).toBeNull();
  });
});
