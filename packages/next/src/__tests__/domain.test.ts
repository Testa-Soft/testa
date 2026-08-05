import { describe, expect, it } from 'vitest';
import { resolveCookieDomain, rootDomainOf } from '../domain.ts';

describe('rootDomainOf', () => {
  it('derives the registrable domain from a subdomain', () => {
    expect(rootDomainOf('app.acme.com')).toBe('acme.com');
    expect(rootDomainOf('deep.sub.acme.com')).toBe('acme.com');
  });

  it('returns a two-label domain as-is', () => {
    expect(rootDomainOf('acme.com')).toBe('acme.com');
  });

  it('handles common multi-part public suffixes', () => {
    expect(rootDomainOf('www.foo.co.uk')).toBe('foo.co.uk');
    expect(rootDomainOf('shop.acme.com.au')).toBe('acme.com.au');
  });

  it('returns undefined for localhost and IPs (browsers reject Domain there)', () => {
    expect(rootDomainOf('localhost')).toBeUndefined();
    expect(rootDomainOf('app.localhost')).toBeUndefined();
    expect(rootDomainOf('127.0.0.1')).toBeUndefined();
    expect(rootDomainOf('::1')).toBeUndefined();
  });

  it('returns undefined for a single-label host', () => {
    expect(rootDomainOf('intranet')).toBeUndefined();
  });
});

describe('resolveCookieDomain', () => {
  it('uses an explicit cookieDomain over discovery', () => {
    expect(
      resolveCookieDomain('app.acme.com', { cookieDomain: '.acme.com', discoverRootDomain: true }),
    ).toBe('.acme.com');
  });

  it('discovers the root domain when asked', () => {
    expect(resolveCookieDomain('app.acme.com', { discoverRootDomain: true })).toBe('acme.com');
  });

  it('returns undefined (host-only) when neither is set', () => {
    expect(resolveCookieDomain('app.acme.com', {})).toBeUndefined();
  });
});
