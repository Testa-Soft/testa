import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTestaConfig } from '../load-config.ts';

const VALID: ProjectConfig = {
  project_id: 1,
  slug: 'acme',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'hash-1',
  experiments: [],
};

/** A `Response`-ish stub good enough for `loadTestaConfig`. */
function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('loadTestaConfig', () => {
  it('builds the config URL from host + projectId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'abc123', host: 'https://cfg.example', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cfg.example/api/v1/config/abc123');
  });

  it('trims trailing slashes on the host', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'abc', host: 'https://cfg.example///', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cfg.example/api/v1/config/abc');
  });

  it('URL-encodes the projectId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'a b/c', host: 'https://cfg.example', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cfg.example/api/v1/config/a%20b%2Fc');
  });

  it('sends the accept header and default next.revalidate (30)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'abc', host: 'https://cfg.example', fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit & { next?: unknown },
    ];
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect((init as { next?: { revalidate?: number } }).next).toEqual({ revalidate: 30 });
  });

  it('honours a custom revalidateSec', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({
      projectId: 'abc',
      host: 'https://cfg.example',
      revalidateSec: 120,
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { next?: { revalidate?: number } },
    ];
    expect(init.next).toEqual({ revalidate: 120 });
  });

  it('uses the TESTA_CONFIG_HOST env var when no host prop is given', async () => {
    vi.stubEnv('TESTA_CONFIG_HOST', 'https://env-host.example/');
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'abc', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://env-host.example/api/v1/config/abc');
  });

  it('falls back to the default host when host prop + env are unset', async () => {
    vi.stubEnv('TESTA_CONFIG_HOST', '');
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    await loadTestaConfig({ projectId: 'abc', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://config.testa-soft.tech/api/v1/config/abc');
  });

  it('returns the config on a valid body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID));
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toEqual(
      VALID,
    );
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID, false));
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toBeNull();
  });

  it('returns null when fetch throws (fail open)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('bad json');
          },
        }) as unknown as Response,
    );
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toBeNull();
  });

  it('returns null on a shape-invalid body (missing experiments)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toBeNull();
  });

  it('returns null when experiments is not an array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ experiments: 'x' }));
    expect(await loadTestaConfig({ projectId: 'abc', host: 'https://x', fetchImpl })).toBeNull();
  });
});
