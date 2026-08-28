/**
 * A redirect WE cause must never cost the visitor a query param. `exact` and
 * `regex` route through `mergeParams` and always did; `contains` is a raw string
 * replace, so a `from_url` carrying a `?` swallowed the separator and turned the
 * entire query into pathname — campaign attribution gone, and any rule matching
 * on a param dead from then on.
 */

import { describe, expect, it } from 'vitest';
import { buildLogUrl } from '../log-url.ts';
import { resolveRedirectDestination } from '../redirect/decide.ts';

const ADS = 'flow=checkout11&campaign_id=1202334&fbclid=IwAR3xQ';
const CURRENT = `https://acme.com/checkout?${ADS}`;
const keysOf = (u: string) => [...new URL(u, 'https://x.invalid').searchParams.keys()].sort();

describe('visitor params survive every redirect mode', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'exact',
      {
        url_match_type: 'exact',
        from_url: 'https://acme.com/checkout',
        to_url: 'https://acme.com/checkout-v2',
      },
    ],
    [
      'contains',
      {
        url_match_type: 'contains',
        from_url: 'https://acme.com/checkout',
        to_url: 'https://acme.com/checkout-v2',
      },
    ],
    [
      'regex',
      {
        url_match_type: 'regex',
        from_url: '^https://acme\\.com/checkout',
        to_url: 'https://acme.com/checkout-v2',
      },
    ],
    // The shape that used to wipe everything: from_url includes the query, so
    // `contains` eats the `?` and the rest becomes path.
    [
      'contains, from_url carries a query',
      {
        url_match_type: 'contains',
        from_url: 'https://acme.com/checkout?flow=checkout11',
        to_url: 'https://acme.com/checkout-v2',
      },
    ],
  ];

  for (const [label, change] of cases) {
    it(label, () => {
      const d = resolveRedirectDestination({ type: 'redirect', ...change } as never, CURRENT);
      expect(d.shouldRedirect).toBe(true);
      expect(keysOf(d.finalUrl as string)).toEqual(['campaign_id', 'fbclid', 'flow']);
    });
  }

  it('does not invent params the visitor never had', () => {
    const d = resolveRedirectDestination(
      {
        type: 'redirect',
        url_match_type: 'exact',
        from_url: 'https://acme.com/checkout',
        to_url: 'https://acme.com/checkout-v2',
      } as never,
      'https://acme.com/checkout',
    );
    expect(keysOf(d.finalUrl as string)).toEqual([]);
  });

  it("leaves a destination-authored param in place and adds the visitor's", () => {
    const d = resolveRedirectDestination(
      {
        type: 'redirect',
        url_match_type: 'exact',
        from_url: 'https://acme.com/checkout',
        to_url: 'https://acme.com/checkout?testa=aa',
      } as never,
      CURRENT,
    );
    expect(keysOf(d.finalUrl as string)).toEqual(['campaign_id', 'fbclid', 'flow', 'testa']);
  });
});

describe('buildLogUrl — 3.3.3 sendLog parity', () => {
  it('base64s the payload into ?data= with the level and cache-buster', () => {
    const url = buildLogUrl('https://new.testa-soft.tech/', 'debug', { a: 1 }, 7) as string;
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/log');
    expect(parsed.searchParams.get('type')).toBe('debug');
    expect(parsed.searchParams.get('r')).toBe('7');
    expect(JSON.parse(atob(parsed.searchParams.get('data') as string))).toEqual({ a: 1 });
  });

  it('survives non-Latin1 payloads, which raw btoa throws on', () => {
    expect(() => btoa(JSON.stringify({ t: 'Möerie · 日本' }))).toThrow();
    const url = buildLogUrl('https://h', 'warning', { t: 'Möerie · 日本' }, 1) as string;
    const data = new URL(url).searchParams.get('data') as string;
    expect(JSON.parse(decodeURIComponent(escape(atob(data))))).toEqual({ t: 'Möerie · 日本' });
  });
});
