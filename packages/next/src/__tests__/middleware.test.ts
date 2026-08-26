/**
 * End-to-end middleware test through real `next/server` NextRequest/NextResponse
 * — proves the split-URL flow: 307 to the variant + Set-Cookie, control passes
 * through, prefetch is a no-op.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function request(
  url: string,
  opts: { cookie?: string; prefetch?: boolean; data?: boolean } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.prefetch) headers.set('next-router-prefetch', '1');
  // Next normalizes a data request's URL to the page path before middleware
  // sees it, and marks it with this header.
  if (opts.data) headers.set('x-nextjs-data', '1');
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
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
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
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(res.headers.get('x-middleware-request-x-testa-shield')).toBe('0');
      expect(res.headers.get('set-cookie')).toContain('_testa_uuid=');
    });

    it('treats a handler returning undefined as pass-through (shield + cookies intact)', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: () => undefined,
      });
      const res = await proxy(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
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

  describe('non-GET requests (Server Actions, form posts) are never experiment traffic', () => {
    // The regression this fixes: a Server Action POSTs to the CURRENT page URL;
    // a matching split-URL rule 307-redirected the POST (307 preserves the
    // method), breaking the action — the visitor just stayed on the page.
    const post = (headers: Record<string, string> = {}): NextRequest =>
      new NextRequest(new URL('https://acme.com/pricing'), {
        method: 'POST',
        headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`, ...headers }),
      });

    it('passes a POST through untouched even when a redirect rule matches (no 307, no cookies)', async () => {
      const res = await mw()(post());
      expect(res.status).not.toBe(307);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes a Server Action POST (next-action header) through untouched', async () => {
      const res = await mw()(post({ 'next-action': 'abc123' }));
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('never fetches config for a POST', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      await proxy(post());
      expect(configFetched).toBe(false);
    });

    it('still runs the composed handler on a POST (bypass stays transparent)', async () => {
      let sawMethod: string | undefined;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawMethod = req.method;
          return NextResponse.next();
        },
      });
      await proxy(post());
      expect(sawMethod).toBe('POST');
    });

    it('redirects HEAD for an assigned visitor but never commits (no Set-Cookie)', async () => {
      // curl -I / uptime monitors: show the real redirect, but never mint a
      // visitor or fire an exposure for a request that isn't a real pageview.
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), {
          method: 'HEAD',
          headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('passes a fresh visitor’s HEAD through without minting cookies', async () => {
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), { method: 'HEAD' }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  describe('speculative loads (Sec-Purpose) and crawlers never commit', () => {
    it('warms a Speculation-Rules prefetch/prerender to the variant without committing', async () => {
      const res = await mw()(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'sec-purpose': 'prefetch;prerender',
          }),
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/pricing-v2');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    const crawlerUa = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

    it('bypasses a crawler entirely: no redirect, no cookies, no config fetch', async () => {
      let configFetched = false;
      const proxy = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => {
          configFetched = true;
          return splitUrlConfig();
        },
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'user-agent': crawlerUa,
          }),
        }),
      );
      expect(res.status).not.toBe(307);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(configFetched).toBe(false);
    });

    it('traces the bot bypass when debug is on', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        debug: true,
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ 'user-agent': crawlerUa }),
        }),
      );
      expect(JSON.parse(res.headers.get('x-testa-debug') ?? '{}')).toMatchObject({
        bypass: 'bot',
      });
    });

    it('skipBots: false opts back into treating crawlers as visitors', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        skipBots: false,
      });
      const res = await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'user-agent': crawlerUa,
          }),
        }),
      );
      expect(res.status).toBe(307);
    });

    it('still runs the composed handler for a crawler (bypass stays transparent)', async () => {
      let sawUa: string | null = null;
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          sawUa = req.headers.get('user-agent');
          return NextResponse.next();
        },
      });
      await proxy(
        new NextRequest(new URL('https://acme.com/pricing'), {
          headers: new Headers({ 'user-agent': crawlerUa }),
        }),
      );
      expect(sawUa).toBe(crawlerUa);
    });
  });

  describe('debug tracing (`debug: true`)', () => {
    const debugMw = () =>
      createTestaProxy({ projectId: 'acme', config: splitUrlConfig(), debug: true });
    const trace = (res: Response): Record<string, unknown> =>
      JSON.parse(res.headers.get('x-testa-debug') ?? '{}');

    it('emits no header (and no log) by default', async () => {
      const res = await mw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.headers.get('x-testa-debug')).toBeNull();
    });

    it('traces a redirect decision: resolved URL, its source, assignment, target', async () => {
      const res = await debugMw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
      );
      expect(res.status).toBe(307);
      expect(trace(res)).toMatchObject({
        url: 'https://acme.com/pricing',
        urlSource: 'request-url',
        applied: [{ experiment: 101, variation: 2 }],
        redirect: 'https://acme.com/pricing-v2',
      });
    });

    it('traces a pass-through decision with the shield verdict', async () => {
      const res = await debugMw()(
        request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
      );
      expect(trace(res)).toMatchObject({ url: 'https://acme.com/pricing', shield: false });
      expect(trace(res)).not.toHaveProperty('redirect');
    });

    it('traces WHY a request was bypassed — the Server Action POST case', async () => {
      const res = await debugMw()(
        new NextRequest(new URL('https://acme.com/pricing'), { method: 'POST' }),
      );
      expect(trace(res)).toMatchObject({ bypass: 'method', method: 'POST' });
    });

    it('traces a path bypass and a no-config fail-open', async () => {
      const asset = await debugMw()(request('https://acme.com/logo.png'));
      expect(trace(asset)).toMatchObject({ bypass: 'path' });

      const noConfig = createTestaProxy({
        projectId: 'acme',
        loadConfig: async () => null,
        debug: true,
      });
      const res = await noConfig(request('https://acme.com/pricing'));
      expect(trace(res)).toMatchObject({ bypass: 'no-config' });
    });

    it('traces the winning URL mechanism behind an ingress', async () => {
      const res = await debugMw()(
        new NextRequest(new URL('http://10.0.3.17:3000/pricing'), {
          headers: new Headers({
            cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
            'x-forwarded-host': 'acme.com',
            'x-forwarded-proto': 'https',
          }),
        }),
      );
      expect(trace(res)).toMatchObject({
        url: 'https://acme.com/pricing',
        urlSource: 'x-forwarded-host',
        redirect: 'https://acme.com/pricing-v2',
      });
    });
  });

  describe('public-URL resolution (container/ingress rewrites Host to an internal one)', () => {
    // The regression this fixes: split-URL rules target PUBLIC URLs, so a
    // request whose Host was rewritten by istio/ingress would never match.
    const internal = (headers: Record<string, string>): NextRequest =>
      new NextRequest(new URL('http://10.0.3.17:3000/pricing'), {
        headers: new Headers({ cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`, ...headers }),
      });

    it('does NOT match on the internal URL without any public-host signal (the bug)', async () => {
      const res = await mw()(internal({}));
      expect(res.status).not.toBe(307);
    });

    it('recovers the public URL from X-Forwarded-Host/Proto and redirects', async () => {
      const res = await mw()(
        internal({ 'x-forwarded-host': 'acme.com', 'x-forwarded-proto': 'https' }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('recovers the public URL from RFC 7239 Forwarded', async () => {
      const res = await mw()(internal({ forwarded: 'for=192.0.2.60;proto=https;host=acme.com' }));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('honors the x-testa-host escape hatch over mangled forwarded headers', async () => {
      const res = await mw()(
        internal({
          'x-testa-host': 'acme.com',
          'x-testa-proto': 'https',
          'x-forwarded-host': 'svc.cluster.local',
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('honors the explicit publicHost option with no headers at all', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        publicHost: 'https://acme.com',
      });
      const res = await proxy(internal({}));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://acme.com/pricing-v2');
    });

    it('uses the public hostname (not the internal one) for discoverRootDomain cookies', async () => {
      const proxy = createTestaProxy({
        projectId: 'acme',
        config: splitUrlConfig(),
        discoverRootDomain: true,
      });
      const res = await proxy(
        internal({ 'x-forwarded-host': 'www.acme.com', 'x-forwarded-proto': 'https' }),
      );
      expect(res.headers.get('set-cookie') ?? '').toContain('Domain=acme.com');
    });
  });

  describe('Pages Router soft navigations (`_next/data` requests)', () => {
    it('decides them — a soft nav is the only signal a Pages Router site sends', async () => {
      const res = await mw()(
        request('https://acme.com/pricing', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
          data: true,
        }),
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/pricing-v2');
    });

    it("keeps the visitor's query params out of Next's interpolated ones", async () => {
      // Next sends /_next/data/<id>/pricing.json?utm_source=fb&slug=pricing —
      // `slug` is its own interpolation and must never reach the address bar.
      const res = await mw()(
        request('https://acme.com/pricing?utm_source=fb&slug=pricing', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
          data: true,
        }),
      );
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('utm_source=fb');
      expect(location).not.toContain('slug=pricing');
    });

    it('leaves the query alone on a normal document request', async () => {
      const res = await mw()(
        request('https://acme.com/pricing?utm_source=fb&slug=pricing', {
          cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        }),
      );
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('utm_source=fb');
      expect(location).toContain('slug=pricing');
    });
  });
});
