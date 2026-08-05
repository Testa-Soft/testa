import { describe, expect, it } from 'vitest';
import { buildRedirectUrl } from '../redirect/build-url.ts';
import type { RedirectChange } from '../redirect/decide.ts';

const change = (over: Partial<RedirectChange>): RedirectChange => ({
  type: 'redirect',
  from_url: 'https://acme.com/a',
  to_url: 'https://acme.com/b',
  ...over,
});

const CURRENT = 'https://acme.com/a?foo=bar&utm_source=fb';

describe('buildRedirectUrl — preserves existing URL params across all modes', () => {
  it('exact (absolute to_url)', () => {
    const out = buildRedirectUrl(CURRENT, change({ url_match_type: 'exact' }));
    expect(out).toBe('https://acme.com/b?foo=bar&utm_source=fb');
  });

  it('exact (relative to_url stays relative)', () => {
    const out = buildRedirectUrl(CURRENT, change({ to_url: '/b', url_match_type: 'exact' }));
    expect(out).toBe('/b?foo=bar&utm_source=fb');
  });

  it('contains (naive first-occurrence replace — pixel parity)', () => {
    const out = buildRedirectUrl(
      'https://acme.com/pricing?foo=bar&utm_source=fb',
      change({ from_url: '/pricing', to_url: '/pricing-v2', url_match_type: 'contains' }),
    );
    expect(out).toBe('https://acme.com/pricing-v2?foo=bar&utm_source=fb');
  });

  it('query (keeps current params, adds/overwrites from to_url)', () => {
    const out = buildRedirectUrl(CURRENT, change({ to_url: 'ref=email', url_match_type: 'query' }));
    expect(out).toContain('foo=bar');
    expect(out).toContain('utm_source=fb');
    expect(out).toContain('ref=email');
  });

  it('regex (now preserves current params)', () => {
    const out = buildRedirectUrl(
      CURRENT,
      change({ from_url: 'acme\\.com/a', to_url: 'https://acme.com/b', url_match_type: 'regex' }),
    );
    expect(out).toContain('/b');
    expect(out).toContain('foo=bar');
    expect(out).toContain('utm_source=fb');
  });

  it('destination wins on a key conflict; current fills the rest', () => {
    const out = buildRedirectUrl(
      'https://acme.com/a?foo=1&keep=yes',
      change({ to_url: 'https://acme.com/b?foo=2', url_match_type: 'exact' }),
    );
    expect(out).toContain('foo=2');
    expect(out).not.toContain('foo=1');
    expect(out).toContain('keep=yes');
  });

  it('drops internal _testa_ params', () => {
    const out = buildRedirectUrl(
      'https://acme.com/a?foo=bar&_testa_cd=xyz',
      change({ url_match_type: 'exact' }),
    );
    expect(out).toContain('foo=bar');
    expect(out).not.toContain('_testa_cd');
  });
});
