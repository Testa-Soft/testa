import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfigUrl, fetchProjectConfig, isProjectConfig } from '../config-fetch.ts';
import { splitUrlConfig } from './helpers.ts';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildConfigUrl', () => {
  it('builds host + /api/v1/config/{projectId}, trimming trailing slashes', () => {
    expect(buildConfigUrl('https://cfg.example///', 'abc')).toBe(
      'https://cfg.example/api/v1/config/abc',
    );
  });

  it('falls back to TESTA_CONFIG_HOST, then the built-in host', () => {
    vi.stubEnv('TESTA_CONFIG_HOST', 'https://env.example');
    expect(buildConfigUrl('', 'abc')).toBe('https://env.example/api/v1/config/abc');
    vi.unstubAllEnvs();
    expect(buildConfigUrl('', 'abc')).toContain('config.testa-soft.tech');
  });

  it('url-encodes the projectId', () => {
    expect(buildConfigUrl('https://cfg.example', 'a b/c')).toBe(
      'https://cfg.example/api/v1/config/a%20b%2Fc',
    );
  });
});

describe('fetchProjectConfig', () => {
  it('returns a valid config and sends the accept header + an abort signal', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn(async () => jsonResponse(config));
    const result = await fetchProjectConfig('https://cfg.example/x', { fetchImpl });
    expect(result).toEqual(config);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('merges extra init (Next revalidate) without losing the accept header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(splitUrlConfig()));
    await fetchProjectConfig('https://cfg.example/x', {
      fetchImpl,
      init: { cache: 'no-store' },
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
  });

  it('fails open (null) on non-2xx, invalid body, and thrown fetch', async () => {
    expect(
      await fetchProjectConfig('u', { fetchImpl: vi.fn(async () => jsonResponse({}, false)) }),
    ).toBeNull();
    expect(
      await fetchProjectConfig('u', {
        fetchImpl: vi.fn(async () => jsonResponse({ error: 'not a config' })),
      }),
    ).toBeNull();
    expect(
      await fetchProjectConfig('u', {
        fetchImpl: vi.fn(async () => {
          throw new Error('network down');
        }),
      }),
    ).toBeNull();
  });

  it('aborts a hung fetch at the timeout budget and fails open', async () => {
    // A fetch that never resolves on its own — only the abort signal ends it.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const result = await fetchProjectConfig('https://cfg.example/x', {
      fetchImpl,
      timeoutMs: 20,
    });
    expect(result).toBeNull();
  });
});

describe('isProjectConfig', () => {
  it('accepts an object with an experiments array, rejects everything else', () => {
    expect(isProjectConfig(splitUrlConfig())).toBe(true);
    expect(isProjectConfig({ experiments: [] })).toBe(true);
    expect(isProjectConfig({ experiments: 'nope' })).toBe(false);
    expect(isProjectConfig(null)).toBe(false);
    expect(isProjectConfig('config')).toBe(false);
  });
});
