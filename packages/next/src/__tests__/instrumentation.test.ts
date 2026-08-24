import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearConfigSnapshot, readConfigSnapshot } from '../config-snapshot.ts';
import { type TestaConfigPoller, registerTestaConfig } from '../instrumentation/index.ts';
import { splitUrlConfig } from './helpers.ts';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const pollers: TestaConfigPoller[] = [];
async function register(
  opts: Partial<Parameters<typeof registerTestaConfig>[0]> & { fetchImpl: typeof fetch },
): Promise<TestaConfigPoller> {
  const poller = await registerTestaConfig({ projectId: 'acme', ...opts });
  pollers.push(poller);
  return poller;
}

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop();
  clearConfigSnapshot();
  vi.useRealTimers();
});

describe('registerTestaConfig', () => {
  it('validates its inputs', async () => {
    await expect(registerTestaConfig({ projectId: '' })).rejects.toThrow('projectId');
    await expect(registerTestaConfig({ projectId: 'x', intervalMs: -5 })).rejects.toThrow(
      'intervalMs',
    );
  });

  it('awaits the first poll so the snapshot is warm before traffic', async () => {
    const config = splitUrlConfig();
    const fetchImpl = vi.fn(async () => jsonResponse(config)) as unknown as typeof fetch;
    await register({ fetchImpl });
    expect(readConfigSnapshot('acme')).toEqual(config);
  });

  it('polls with cache:no-store (the poller IS the cache, never Next data cache)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(splitUrlConfig())) as unknown as typeof fetch;
    await register({ fetchImpl });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toContain('/api/v1/config/acme');
    expect(init.cache).toBe('no-store');
  });

  it('a failed boot poll is not fatal — refresh() self-heals later', async () => {
    let healthy = false;
    const fetchImpl = vi.fn(async () =>
      healthy ? jsonResponse(splitUrlConfig()) : jsonResponse({}, false),
    ) as unknown as typeof fetch;

    const poller = await register({ fetchImpl });
    expect(readConfigSnapshot('acme')).toBeNull();

    healthy = true;
    expect(await poller.refresh()).toBe(true);
    expect(readConfigSnapshot('acme')).not.toBeNull();
  });

  it('a failed poll never downgrades a good snapshot (last-known-good)', async () => {
    const good = splitUrlConfig();
    let healthy = true;
    const fetchImpl = vi.fn(async () =>
      healthy ? jsonResponse(good) : jsonResponse({ error: 'boom' }),
    ) as unknown as typeof fetch;

    const poller = await register({ fetchImpl });
    healthy = false;
    expect(await poller.refresh()).toBe(false);
    expect(readConfigSnapshot('acme')).toEqual(good);
  });

  it('refreshes on the interval (floored at 5s) and stops cleanly', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse(splitUrlConfig())) as unknown as typeof fetch;
    const spy = fetchImpl as ReturnType<typeof vi.fn>;

    const poller = await register({ fetchImpl, intervalMs: 1 }); // floored to 5s
    expect(spy).toHaveBeenCalledTimes(1); // boot poll

    await vi.advanceTimersByTimeAsync(4_999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2); // no ticks after stop
    expect(readConfigSnapshot('acme')).not.toBeNull(); // snapshot survives stop
  });

  it('re-registering the same project replaces the poller instead of stacking timers', async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => jsonResponse(splitUrlConfig())) as unknown as typeof fetch;
    const second = vi.fn(async () => jsonResponse(splitUrlConfig())) as unknown as typeof fetch;

    await register({ fetchImpl: first });
    await register({ fetchImpl: second });

    await vi.advanceTimersByTimeAsync(60_000);
    expect((first as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // boot only, timer replaced
    expect((second as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a body that is not a ProjectConfig', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: 'error page' }),
    ) as unknown as typeof fetch;
    await register({ fetchImpl });
    expect(readConfigSnapshot('acme')).toBeNull();
  });
});

describe('snapshot typing', () => {
  it('round-trips the full ProjectConfig shape', async () => {
    const config: ProjectConfig = splitUrlConfig();
    const fetchImpl = vi.fn(async () => jsonResponse(config)) as unknown as typeof fetch;
    await register({ fetchImpl });
    expect(readConfigSnapshot('acme')?.experiments).toEqual(config.experiments);
  });
});
