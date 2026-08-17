import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRACKING_HOST, emitExposure } from '../tracking.ts';

afterEach(() => vi.restoreAllMocks());

describe('emitExposure', () => {
  const payload = {
    project_id: 1,
    experiment: 101,
    variation: 2,
    uuid: 'v',
    title: 'Pricing test',
    url: 'https://acme.com/pricing',
  };

  it('POSTs to {host}/api/leads with the payload', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await emitExposure('https://track.example.com/', payload);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe('https://track.example.com/api/leads');
    const init = call?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({ experiment: 101, variation: 2 });
  });

  it('never rejects on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(emitExposure(DEFAULT_TRACKING_HOST, payload)).resolves.toBeUndefined();
  });
});
