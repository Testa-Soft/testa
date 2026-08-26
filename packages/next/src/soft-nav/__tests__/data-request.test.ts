/**
 * Pages Router data requests — the soft-navigation hop.
 *
 * The stakes: these requests are where a visitor entering a funnel by CLICKING
 * gets bucketed, so they must be decided, not bypassed. But Next appends the
 * route's own interpolated params to them, and anything merged into a redirect
 * `Location` shows up in the visitor's address bar — including a `gender=male`
 * that contradicts the page they were just sent to.
 */

import { describe, expect, it } from 'vitest';
import { isPagesDataRequest, stripInterpolatedParams } from '../data-request.ts';

const headers = (init: Record<string, string> = {}): Headers => new Headers(init);

describe('isPagesDataRequest', () => {
  it('recognises the header Next sets on a client-navigation data fetch', () => {
    expect(isPagesDataRequest(headers({ 'x-nextjs-data': '1' }))).toBe(true);
  });

  it('is false for a normal document request', () => {
    expect(isPagesDataRequest(headers())).toBe(false);
    expect(isPagesDataRequest(headers({ 'x-nextjs-data': '' }))).toBe(false);
  });
});

describe('stripInterpolatedParams', () => {
  it('drops the route params, keeps the real query', () => {
    // What Next actually sends for /question/male/1?flow=7247&utm_source=fb
    const url = new URL(
      'https://acme.com/question/male/1?flow=7247&utm_source=fb&gender=male&step=1',
    );
    const cleaned = stripInterpolatedParams(url);
    expect(cleaned.searchParams.get('flow')).toBe('7247');
    expect(cleaned.searchParams.get('utm_source')).toBe('fb');
    expect(cleaned.searchParams.has('gender')).toBe(false);
    expect(cleaned.searchParams.has('step')).toBe(false);
    expect(cleaned.pathname).toBe('/question/male/1');
  });

  it('returns the URL untouched when nothing matches a segment', () => {
    const url = new URL('https://acme.com/pricing?utm_source=fb');
    expect(stripInterpolatedParams(url).href).toBe(url.href);
  });

  it('handles a catch-all route, whose param is the joined remainder', () => {
    const url = new URL('https://acme.com/docs/a/b?slug=docs/a/b&utm=x');
    const cleaned = stripInterpolatedParams(url);
    expect(cleaned.searchParams.has('slug')).toBe(false);
    expect(cleaned.searchParams.get('utm')).toBe('x');
  });

  it('keeps a param whose value only resembles a segment', () => {
    const url = new URL('https://acme.com/question/male/1?gender=female');
    expect(stripInterpolatedParams(url).searchParams.get('gender')).toBe('female');
  });

  it('survives a malformed percent-escape in the path', () => {
    const url = new URL('https://acme.com/question/%E0%A4%A/1?step=1');
    expect(() => stripInterpolatedParams(url)).not.toThrow();
  });

  it('leaves a query-less URL alone', () => {
    const url = new URL('https://acme.com/question/male/1');
    expect(stripInterpolatedParams(url).href).toBe(url.href);
  });
});
