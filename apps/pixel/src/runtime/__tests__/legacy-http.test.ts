import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postLead, postLeadConvert, postPixel } from '../legacy-http.ts';

const DOMAIN = 'https://api.example.com';

function mockAnalytica(overrides: Partial<typeof window.Analytica> = {}): void {
  (window as unknown as Record<string, unknown>).Analytica = {
    domain: DOMAIN,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    sent: {},
    ...overrides,
  };
}

function clearAnalytica(): void {
  (window as unknown as Record<string, unknown>).Analytica = undefined;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
  mockAnalytica();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAnalytica();
});

describe('postLead', () => {
  it('POSTs /api/leads with experiment, variation, and visitor', () => {
    postLead(42, 100, 'visitor-uuid-1');

    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DOMAIN}/api/leads`);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      experiment: 42,
      variation: 100,
      visitor: 'visitor-uuid-1',
    });
  });

  it('uses Analytica.headers on the request', () => {
    postLead(1, 1, 'v');
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('dedup: does not re-fire for the same experimentId within the session', () => {
    postLead(42, 100, 'visitor-uuid-1');
    postLead(42, 100, 'visitor-uuid-1');
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it('dedup: allows different experimentIds', () => {
    postLead(42, 100, 'visitor-uuid-1');
    postLead(99, 200, 'visitor-uuid-1');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('sets Analytica.sent[experimentId] = 1 after first call', () => {
    postLead(42, 100, 'v');
    expect(window.Analytica?.sent[42]).toBe(1);
  });

  it('no-ops when Analytica is not installed', () => {
    clearAnalytica();
    expect(() => postLead(1, 1, 'v')).not.toThrow();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when domain is empty', () => {
    mockAnalytica({ domain: '' });
    postLead(1, 1, 'v');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('postLeadConvert', () => {
  it('POSTs /api/leads/convert with experiment and goal', () => {
    postLeadConvert(42, 7);

    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DOMAIN}/api/leads/convert`);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({
      experiment: 42,
      goal: 7,
    });
  });

  it('spreads extra data into the body', () => {
    postLeadConvert(42, 7, { revenue: 99.9, currency: 'USD' });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.revenue).toBe(99.9);
    expect(body.currency).toBe('USD');
  });

  it('does not dedup across multiple goal fires', () => {
    postLeadConvert(42, 7);
    postLeadConvert(42, 7);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('no-ops when domain is empty', () => {
    mockAnalytica({ domain: '' });
    postLeadConvert(1, 1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('postPixel', () => {
  it('GETs /api/pixel with event and data as query params', () => {
    postPixel('checkout', { product_id: '123', quantity: '1' });

    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/pixel');
    expect(parsed.searchParams.get('event')).toBe('checkout');
    expect(parsed.searchParams.get('product_id')).toBe('123');
    expect(parsed.searchParams.get('quantity')).toBe('1');
  });

  it('uses keepalive on the request', () => {
    postPixel('order_completed', {});
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });

  it('no-ops when domain is empty', () => {
    mockAnalytica({ domain: '' });
    postPixel('ev', {});
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('no-ops when domain is not a valid URL base', () => {
    mockAnalytica({ domain: 'not-a-url' });
    expect(() => postPixel('ev', {})).not.toThrow();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
