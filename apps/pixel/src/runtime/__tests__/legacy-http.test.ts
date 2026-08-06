import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postLead, postLeadConvert, postPixel } from '../legacy-http.ts';
import { __resetForTests, installLegacy } from '../legacy/index.ts';

const DOMAIN = 'https://api.testa.com';

beforeEach(() => {
  __resetForTests();
  (window as unknown as Record<string, unknown>).cfPrefill = { apiUrl: DOMAIN };
  installLegacy({ pushEvent: () => {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  __resetForTests();
  vi.unstubAllGlobals();
});

const mockFetch = () => vi.mocked(fetch);

describe('postLead', () => {
  it('POSTs the 3.6 body shape to /api/leads', async () => {
    await postLead(17, 100, 'visitor-abc');
    expect(mockFetch()).toHaveBeenCalledWith(
      `${DOMAIN}/api/leads`,
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ experiment: 17, variation: 100, visitor: 'visitor-abc' }),
      }),
    );
  });

  it('sends Analytica.headers as the request headers', async () => {
    await postLead(17, 100, 'visitor-abc');
    const [, init] = mockFetch().mock.calls[0] ?? [];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');
  });

  it('dedup: second call for the same experimentId is a no-op', async () => {
    await postLead(17, 100, 'visitor-abc');
    await postLead(17, 100, 'visitor-abc');
    expect(mockFetch()).toHaveBeenCalledTimes(1);
  });

  it('allows a second call for a different experimentId', async () => {
    await postLead(17, 100, 'v');
    await postLead(42, 200, 'v');
    expect(mockFetch()).toHaveBeenCalledTimes(2);
  });

  it('sets Analytica.sent[experimentId] to 1 after firing', async () => {
    await postLead(17, 100, 'visitor-abc');
    expect(window.Analytica?.sent[17]).toBe(1);
  });

  it('is a no-op when window.Analytica is not installed', async () => {
    (window as unknown as Record<string, unknown>).Analytica = undefined;
    await postLead(17, 100, 'visitor-abc');
    expect(mockFetch()).not.toHaveBeenCalled();
  });
});

describe('postLeadConvert', () => {
  it('POSTs the 3.6 body shape to /api/leads/convert', async () => {
    await postLeadConvert(17, 5, 'visitor-abc');
    expect(mockFetch()).toHaveBeenCalledWith(
      `${DOMAIN}/api/leads/convert`,
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ experiment: 17, goal: 5, visitor: 'visitor-abc' }),
      }),
    );
  });

  it('is a no-op when visitorId is null', async () => {
    await postLeadConvert(17, 5, null);
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it('is a no-op when window.Analytica is not installed', async () => {
    (window as unknown as Record<string, unknown>).Analytica = undefined;
    await postLeadConvert(17, 5, 'v');
    expect(mockFetch()).not.toHaveBeenCalled();
  });
});

describe('postPixel', () => {
  it('GETs /api/pixel with the forwarded query params', () => {
    postPixel({ shopify_event: 'page_viewed', value: '99.99' });
    const calls = mockFetch().mock.calls;
    expect(calls.length).toBe(1);
    const url = calls[0]?.[0] as string;
    expect(url).toContain('/api/pixel?');
    expect(url).toContain('shopify_event=page_viewed');
    expect(url).toContain('value=99.99');
    const [, init] = calls[0] ?? [];
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).keepalive).toBe(true);
  });

  it('is a no-op when Analytica.domain is empty', () => {
    const a = window.Analytica;
    if (a) a.domain = '';
    postPixel({ key: 'val' });
    expect(mockFetch()).not.toHaveBeenCalled();
  });

  it('is a no-op when window.Analytica is not installed', () => {
    (window as unknown as Record<string, unknown>).Analytica = undefined;
    postPixel({ key: 'val' });
    expect(mockFetch()).not.toHaveBeenCalled();
  });
});
