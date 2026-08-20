/**
 * End-to-end middleware test through real `next/server` NextRequest/NextResponse
 * — proves the split-URL flow: 307 to the variant + Set-Cookie, control passes
 * through, prefetch is a no-op.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function request(url: string, opts: { cookie?: string; prefetch?: boolean } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.prefetch) headers.set('next-router-prefetch', '1');
  return new NextRequest(new URL(url), { headers });
}

const mw = () => createTestaProxy({ projectSlug: 'acme', config: splitUrlConfig() });

describe('createTestaProxy', () => {
  it('307-redirects a redirect-variation visitor to the variant', async () => {
    const res = await mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('passes a control-variation visitor through without redirect', async () => {
    const res = await mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
    );
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('mints a _testa_uuid cookie for a fresh visitor', async () => {
    const res = await mw()(request('https://acme.com/home'));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('_testa_uuid=');
  });

  it('warms a prefetch to the variant for an already-assigned visitor, but never commits (no Set-Cookie)', async () => {
    // Soft-nav M1: a sticky (cookie-first) assignment is stable, so we redirect
    // the prefetch to warm the variant RSC — but write nothing.
    const res = await mw()(
      request('https://acme.com/pricing', {
        cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        prefetch: true,
      }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('passes a fresh visitor’s prefetch through (speculative bucket not committed, no mint)', async () => {
    const res = await mw()(request('https://acme.com/pricing', { prefetch: true }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('fails open (pass-through) when config resolves to null', async () => {
    const mwNoConfig = createTestaProxy({ projectSlug: 'acme', loadConfig: async () => null });
    const res = await mwNoConfig(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).not.toBe(307);
  });

  describe('handler composition (customer middleware runs INSIDE the proxy)', () => {
    it('passes x-testa-shield to the handler and keeps its own request overrides', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }));
      // Handler's own override AND testa's shield both survive on ONE response.
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      // Testa cookies merge onto the handler's response.
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('patches the shield override even when the handler returns a plain next()', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => NextResponse.next(),
      });
      const res = await proxy(request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }));
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('treats a handler returning undefined as pass-through (shield + cookies intact)', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => undefined,
      });
      const res = await proxy(request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }));
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('delegates bypassed requests (e.g. /api/*) straight to the handler', async () => {
      let sawShield: string | null = 'sentinel';
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawShield = req.headers.get('x-testa-shield');
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(request('https://acme.com/api/leads'));
      // Handler ran and its API-route headers survive; testa stayed out entirely.
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(sawShield).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('skips the handler on a split-URL redirect (nothing downstream renders)', async () => {
      let handlerRan = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => {
          handlerRan = true;
          return NextResponse.next();
        },
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(handlerRan).toBe(false);
    });

    it('delegates to the handler when config fails to resolve (fail open THROUGH the handler)', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => null,
        handler: (req) => {
          const headers = new Headers(req.headers);
          headers.set('x-domain', 'acme.com');
          return NextResponse.next({ request: { headers } });
        },
      });
      const res = await proxy(request('https://acme.com/pricing'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    });

    it('returns a handler redirect as-is, with testa cookies applied', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => NextResponse.redirect(new URL('/login', req.url), 307),
      });
      // Control-assigned visitor → testa passes through, handler's redirect wins.
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });
  });

  describe('tail-call composition (customer proxy runs FIRST, then calls testa)', () => {
    // The customer pattern: mutate request headers, then hand testa the
    // mutated request. Testa must forward those headers downstream on EVERY
    // path, so it is transparent to upstream request mutation.
    function mutatedRequest(url: string, opts: { cookie?: string } = {}): NextRequest {
      const base = request(url, opts);
      const headers = new Headers(base.headers);
      headers.set('x-domain', 'acme.com');
      return new NextRequest(base, { headers });
    }

    it('forwards upstream header mutations on the pass-through path', async () => {
      const res = await mw()(
        mutatedRequest('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
    });

    it('forwards upstream header mutations on the bypass path (/api/*)', async () => {
      const res = await mw()(mutatedRequest('https://acme.com/api/leads'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('forwards upstream header mutations when config fails to resolve', async () => {
      const proxy = createTestaProxy({ projectId: 'acme', loadConfig: async () => null });
      const res = await proxy(mutatedRequest('https://acme.com/pricing'));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
    });

    it('forwards upstream header mutations on a prefetch pass-through', async () => {
      const base = request('https://acme.com/pricing', { prefetch: true });
      const headers = new Headers(base.headers);
      headers.set('x-domain', 'acme.com');
      const res = await mw()(new NextRequest(base, { headers }));
      expect(res.headers.get('x-middleware-request-x-domain')).toBe('acme.com');
      expect(res.headers.get('set-cookie')).toBeNull(); // prefetch still never commits
    });
  });

  describe('internal request filter (safe without a matcher)', () => {
    /** A loose `contains` page rule that would also match asset URLs like /pricing-hero.png. */
    const looseConfig = () => {
      const cfg = splitUrlConfig();
      const exp = cfg.experiments[0];
      if (!exp) throw new Error('splitUrlConfig produced no experiment');
      return {
        ...cfg,
        experiments: [
          { ...exp, rules: [{ match_type: 'contains' as const, url_pattern: '/pricing' }] },
        ],
      };
    };

    it('never redirects an asset even when a loose experiment rule matches it', async () => {
      const proxy = createTestaProxy({ projectId: 'acme', config: looseConfig() });
      const res = await proxy(
        request('https://acme.com/pricing-hero.png', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes /_next/* through untouched (no cookies, no config fetch)', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      const res = await proxy(request('https://acme.com/_next/static/chunks/main.js'));
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(configFetched).toBe(false);
    });

    it('honors custom skipPaths end-to-end', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        skipPaths: ['/pricing'],
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });
});
