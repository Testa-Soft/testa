/**
 * End-to-end middleware test through real `next/server` NextRequest/NextResponse
 * — proves the split-URL flow: 307 to the variant + Set-Cookie, control passes
 * through, prefetch is a no-op.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createTestaMiddleware } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function request(url: string, opts: { cookie?: string; prefetch?: boolean } = {}): NextRequest {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.prefetch) headers.set('next-router-prefetch', '1');
  return new NextRequest(new URL(url), { headers });
}

const mw = () => createTestaMiddleware({ projectSlug: 'acme', config: splitUrlConfig() });

describe('createTestaMiddleware', () => {
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
    const mwNoConfig = createTestaMiddleware({ projectSlug: 'acme', loadConfig: async () => null });
    const res = await mwNoConfig(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).not.toBe(307);
  });
});
