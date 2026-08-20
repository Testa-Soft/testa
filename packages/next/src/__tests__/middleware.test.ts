/**
 * End-to-end middleware test through real `next/server` NextRequest/NextResponse
 * — proves the split-URL flow: 307 to the variant + Set-Cookie, control passes
 * through, prefetch is a no-op.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server';
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
