import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import { clearGuardConfigCache, resolveGuardConfig } from '../guard-config.ts';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

afterEach(() => {
  clearGuardConfigCache();
  vi.unstubAllGlobals();
});

describe('resolveGuardConfig', () => {
  it('an inline config wins without any fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const config = splitUrlConfig();
    expect(await resolveGuardConfig({ config, projectId: 'acme' })).toBe(config);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('projectId mode fetches the servable config once and shares it across mounts', async () => {
    const config = splitUrlConfig();
    const fetchSpy = vi.fn(async () => jsonResponse(config));
    vi.stubGlobal('fetch', fetchSpy);

    const [a, b] = await Promise.all([
      resolveGuardConfig({ projectId: 'acme' }),
      resolveGuardConfig({ projectId: 'acme' }),
    ]);
    expect(a).toEqual(config);
    expect(b).toEqual(config);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/v1/config/acme');
  });

  it('different hosts/projects are cached independently', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(splitUrlConfig()));
    vi.stubGlobal('fetch', fetchSpy);
    await resolveGuardConfig({ projectId: 'acme' });
    await resolveGuardConfig({ projectId: 'acme', host: 'https://staging.example' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a failed fetch resolves null and is NOT cached (a later mount retries)', async () => {
    const config = splitUrlConfig();
    let healthy = false;
    const fetchSpy = vi.fn(async () =>
      healthy ? jsonResponse(config) : jsonResponse({}, false),
    );
    vi.stubGlobal('fetch', fetchSpy);

    expect(await resolveGuardConfig({ projectId: 'acme' })).toBeNull();
    healthy = true;
    expect(await resolveGuardConfig({ projectId: 'acme' })).toEqual(config);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws outside production when neither config nor projectId is passed', () => {
    expect(() => resolveGuardConfig({})).toThrow('projectId');
  });
});
