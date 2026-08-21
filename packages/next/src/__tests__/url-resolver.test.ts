/**
 * Public-URL resolution — the fix for container/ingress topologies (k8s,
 * istio) where the Host reaching Next.js is an internal one (`pod-ip:3000`,
 * `svc.cluster.local`) and split-URL targeting would silently never match.
 */

import { describe, expect, it } from 'vitest';
import { resolvePublicUrl, resolvePublicUrlDetailed } from '../url-resolver.ts';

function req(url: string, headers: Record<string, string> = {}): { url: string; headers: Headers } {
  return { url, headers: new Headers(headers) };
}

describe('resolvePublicUrl', () => {
  it('returns the request URL unchanged when nothing else is available', () => {
    expect(resolvePublicUrl(req('https://acme.com/pricing?x=1')).href).toBe(
      'https://acme.com/pricing?x=1',
    );
  });

  describe('X-Forwarded-Host / X-Forwarded-Proto', () => {
    it('swaps in the forwarded host and proto, keeping path + query', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing?plan=pro', {
          'x-forwarded-host': 'www.acme.com',
          'x-forwarded-proto': 'https',
        }),
      );
      expect(url.href).toBe('https://www.acme.com/pricing?plan=pro');
    });

    it('uses the FIRST value of a comma-separated forwarded list (client-nearest proxy)', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/', {
          'x-forwarded-host': 'www.acme.com, internal-lb.local',
          'x-forwarded-proto': 'https, http',
        }),
      );
      expect(url.host).toBe('www.acme.com');
      expect(url.protocol).toBe('https:');
    });

    it('keeps a forwarded host with an explicit port', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/', { 'x-forwarded-host': 'staging.acme.com:8443' }),
      );
      expect(url.host).toBe('staging.acme.com:8443');
    });

    it('drops the internal port when the forwarded host has none', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing', { 'x-forwarded-host': 'www.acme.com' }),
      );
      expect(url.port).toBe('');
    });

    it('ignores a syntactically invalid forwarded host (header injection)', () => {
      const url = resolvePublicUrl(
        req('https://acme.com/pricing', { 'x-forwarded-host': 'evil.com/phish?u=' }),
      );
      expect(url.href).toBe('https://acme.com/pricing');
    });

    it('ignores a non-http(s) forwarded proto', () => {
      const url = resolvePublicUrl(
        req('https://acme.com/', { 'x-forwarded-proto': 'javascript' }),
      );
      expect(url.protocol).toBe('https:');
    });
  });

  describe('RFC 7239 Forwarded', () => {
    it('reads host= and proto= from the first element', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing', {
          forwarded: 'for=192.0.2.60;proto=https;host=www.acme.com, for=198.51.100.17',
        }),
      );
      expect(url.href).toBe('https://www.acme.com/pricing');
    });

    it('handles quoted values and case-insensitive keys', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/', { forwarded: 'Host="www.acme.com:8443";Proto=https' }),
      );
      expect(url.host).toBe('www.acme.com:8443');
    });

    it('wins over X-Forwarded-* (more specific standard)', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/', {
          forwarded: 'host=rfc.acme.com;proto=https',
          'x-forwarded-host': 'xfh.acme.com',
        }),
      );
      expect(url.host).toBe('rfc.acme.com');
    });
  });

  describe('x-testa-host escape hatch (set at the ingress, beats all forwarded headers)', () => {
    it('wins over Forwarded and X-Forwarded-Host', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing', {
          'x-testa-host': 'www.acme.com',
          'x-testa-proto': 'https',
          forwarded: 'host=mangled.internal;proto=http',
          'x-forwarded-host': 'also-mangled.internal',
        }),
      );
      expect(url.href).toBe('https://www.acme.com/pricing');
    });
  });

  describe('publicHost option (explicit, beats every header)', () => {
    it('accepts a bare host, inferring proto from forwarded headers', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing', { 'x-forwarded-proto': 'https' }),
        'www.acme.com',
      );
      expect(url.href).toBe('https://www.acme.com/pricing');
    });

    it('accepts a full origin, pinning the proto too', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/pricing?x=1', { 'x-forwarded-proto': 'http' }),
        'https://www.acme.com/',
      );
      expect(url.href).toBe('https://www.acme.com/pricing?x=1');
    });

    it('accepts a per-request callback and ignores a null return', () => {
      const fromCb = resolvePublicUrl(req('http://10.0.3.17:3000/a'), (r) =>
        r.headers.get('x-tenant-host'),
      );
      expect(fromCb.host).toBe('10.0.3.17:3000');
      const withHeader = resolvePublicUrl(
        req('http://10.0.3.17:3000/a', { 'x-tenant-host': 'tenant.acme.com' }),
        (r) => r.headers.get('x-tenant-host'),
      );
      expect(withHeader.host).toBe('tenant.acme.com');
    });

    it('falls through to headers when the explicit value is invalid', () => {
      const url = resolvePublicUrl(
        req('http://10.0.3.17:3000/', { 'x-forwarded-host': 'www.acme.com' }),
        'not a host!!',
      );
      expect(url.host).toBe('www.acme.com');
    });
  });

  describe('resolvePublicUrlDetailed (which mechanism won — surfaced by debug tracing)', () => {
    it('labels each source', () => {
      expect(resolvePublicUrlDetailed(req('http://10.0.3.17:3000/'), 'acme.com').source).toBe(
        'option',
      );
      expect(
        resolvePublicUrlDetailed(req('http://10.0.3.17:3000/', { 'x-testa-host': 'acme.com' }))
          .source,
      ).toBe('x-testa-host');
      expect(
        resolvePublicUrlDetailed(req('http://10.0.3.17:3000/', { forwarded: 'host=acme.com' }))
          .source,
      ).toBe('forwarded');
      expect(
        resolvePublicUrlDetailed(
          req('http://10.0.3.17:3000/', { 'x-forwarded-host': 'acme.com' }),
        ).source,
      ).toBe('x-forwarded-host');
      expect(
        resolvePublicUrlDetailed(req('http://10.0.3.17:3000/', { host: 'acme.com' })).source,
      ).toBe('host');
      expect(resolvePublicUrlDetailed(req('http://10.0.3.17:3000/')).source).toBe('request-url');
    });
  });
});
