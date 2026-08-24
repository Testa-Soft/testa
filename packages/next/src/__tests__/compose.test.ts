/**
 * `applyRequestHeaders` — the public escape hatch for OUTER wrappers
 * (customer middleware that calls the testa proxy and wants to add its own
 * request-header overrides on top of our response without touching Next's
 * internal x-middleware-* encoding).
 */

import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { applyRequestHeaders } from '../compose.ts';

const OVERRIDE_LIST = 'x-middleware-override-headers';

function overrideNames(res: NextResponse): string[] {
  return (res.headers.get(OVERRIDE_LIST) ?? '').split(',').filter(Boolean);
}

describe('applyRequestHeaders', () => {
  it('appends to an existing override set without dropping prior overrides', () => {
    const base = new Headers({ accept: 'text/html', 'x-testa-shield': '1' });
    const res = NextResponse.next({ request: { headers: base } });

    applyRequestHeaders(res, { 'x-domain': 'acme.com' });

    expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('1');
    expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    expect(overrideNames(res)).toContain('x-domain');
    expect(overrideNames(res)).toContain('x-testa-shield');
  });

  it('seeds the full override set from the request when the response has none', () => {
    const req = new NextRequest(new URL('https://acme.com/pricing'), {
      headers: new Headers({ accept: 'text/html' }),
    });
    const res = NextResponse.next();

    applyRequestHeaders(res, { 'x-domain': 'acme.com' }, req);

    // Wholesale semantics: original request headers must survive the override.
    expect(res.headers.get('x-middleware-request-accept')).toBe('text/html');
    expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
  });

  it('throws when it cannot build a safe wholesale set (no overrides, no request)', () => {
    const res = NextResponse.next();
    expect(() => applyRequestHeaders(res, { 'x-domain': 'acme.com' })).toThrow(/request/i);
  });

  it('returns a redirect response unchanged (nothing downstream renders)', () => {
    const res = NextResponse.redirect('https://acme.com/pricing-v2', 307);
    applyRequestHeaders(res, { 'x-domain': 'acme.com' });
    expect(res.headers.get(OVERRIDE_LIST)).toBeNull();
    expect(res.headers.get('x-middleware-request-x-domain')).toBeNull();
  });

  it('lowercases header names so the override list stays consistent', () => {
    const res = NextResponse.next({ request: { headers: new Headers({ a: '1' }) } });
    applyRequestHeaders(res, { 'X-Domain': 'acme.com' });
    expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    expect(overrideNames(res)).toContain('x-domain');
  });
});
