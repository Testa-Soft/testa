/**
 * Framework-reserved query params.
 *
 * The invariant these tests exist to hold: NOTHING the visitor has in their
 * address bar is ever removed. Only names Next owns are dropped, because a
 * reserved name is proof of ownership — where a value-based rule would have to
 * guess, and would sometimes guess wrong.
 */

import { describe, expect, it } from 'vitest';
import { stripFrameworkParams } from '../framework-params.ts';

const strip = (href: string): string => stripFrameworkParams(new URL(href)).href;

describe('stripFrameworkParams', () => {
  it("drops the App Router's soft-nav param", () => {
    // Left in, an end-anchored regex rule (`/pricing$`) matches a hard load and
    // silently fails on every soft nav.
    expect(strip('https://acme.com/pricing?_rsc=8f2a1')).toBe('https://acme.com/pricing');
  });

  it('drops __next* plumbing (data requests, i18n, fallback)', () => {
    expect(strip('https://acme.com/p?__nextDataReq=1')).toBe('https://acme.com/p');
    expect(strip('https://acme.com/p?__nextLocale=en&__nextDefaultLocale=en')).toBe(
      'https://acme.com/p',
    );
  });

  it('drops early App Router flight params', () => {
    expect(strip('https://acme.com/p?__flight__=1&__flight_router_state_tree__=%7B%7D')).toBe(
      'https://acme.com/p',
    );
  });

  it("keeps the visitor's params, in order, alongside a stripped one", () => {
    expect(strip('https://acme.com/pricing?utm_source=fb&_rsc=8f2a1&flow=7247')).toBe(
      'https://acme.com/pricing?utm_source=fb&flow=7247',
    );
  });

  it('keeps a param that merely resembles a reserved name', () => {
    // `_rsc` is exact-match; a prefix is not enough to claim ownership.
    expect(strip('https://acme.com/p?_rsc_id=7&next=1&flight=ba12')).toBe(
      'https://acme.com/p?_rsc_id=7&next=1&flight=ba12',
    );
  });

  it('NEVER removes a param just because its value looks like a path segment', () => {
    // The case a value-based rule gets wrong: `year` is the visitor's, and it
    // happens to equal a segment. Next's own interpolated route params are
    // indistinguishable from this, which is why they are left alone.
    expect(strip('https://acme.com/blog/2024?year=2024')).toBe(
      'https://acme.com/blog/2024?year=2024',
    );
    expect(strip('https://acme.com/question/male/1?gender=male&step=1')).toBe(
      'https://acme.com/question/male/1?gender=male&step=1',
    );
  });

  it('returns the same instance when there is nothing to strip', () => {
    const url = new URL('https://acme.com/pricing?utm_source=fb');
    expect(stripFrameworkParams(url)).toBe(url);
  });

  it('handles a query-less URL', () => {
    expect(strip('https://acme.com/pricing')).toBe('https://acme.com/pricing');
  });
});
