/**
 * Rewrite delivery through the proxy — `NextResponse.rewrite` instead of a 307.
 *
 * The visitor's address bar never changes, so this is the flicker-free shape for
 * a customer who can author the variant route: one round trip, the variant is
 * simply what the first response contains, and on Vercel the target can be a
 * prerendered route served from the edge cache.
 */

import { UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

/** `splitUrlConfig`, with the variant switched to rewrite delivery. */
function rewriteConfig(to = 'https://acme.com/pricing-v2') {
  const config = splitUrlConfig({ to });
  const variant = config.experiments[0]?.variations[1];
  const change = variant?.changes[0];
  if (change && change.type === 'redirect') change.nav = 'rewrite';
  return config;
}

function call(config: ReturnType<typeof rewriteConfig>, url = 'https://acme.com/pricing') {
  const proxy = createTestaProxy({ projectId: 'acme', config, tracking: false });
  return proxy(
    new NextRequest(new URL(url), {
      headers: new Headers({
        'sec-fetch-mode': 'navigate',
        // Pinned to the redirect variation so delivery is deterministic.
        cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
      }),
    }),
  );
}

describe('rewrite delivery', () => {
  it('rewrites instead of redirecting — 200, not 307', async () => {
    const res = await call(rewriteConfig());
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
    // Next signals an internal rewrite with x-middleware-rewrite.
    expect(res.headers.get('x-middleware-rewrite')).toContain('/pricing-v2');
  });

  it('still writes the assignment cookie on the rewrite response', async () => {
    const res = await call(rewriteConfig());
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('_testa_exp');
  });

  it('a relative destination resolves against the public origin', async () => {
    const res = await call(rewriteConfig('/pricing-v2'));
    expect(res.headers.get('x-middleware-rewrite')).toContain('acme.com/pricing-v2');
  });

  it('REFUSES a cross-origin target and serves the control page', async () => {
    // Rewriting to another host would turn the customer's deployment into a
    // reverse proxy for it — never what a split-URL test asked for.
    const res = await call(rewriteConfig('https://evil.example/pricing-v2'));
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).not.toBe(307);
  });

  it('does not redirect a visitor assigned to a rewrite variant', async () => {
    // The whole point: they stay where they are.
    const res = await call(rewriteConfig());
    expect(res.status).toBe(200);
  });

  it('leaves the default 307 path untouched', async () => {
    const proxy = createTestaProxy({
      projectId: 'acme',
      config: splitUrlConfig(),
      tracking: false,
    });
    const res = await proxy(
      new NextRequest(new URL('https://acme.com/pricing'), {
        headers: new Headers({
          'sec-fetch-mode': 'navigate',
          cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
        }),
      }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });
});

describe('rewrite + prefetch warming', () => {
  it('warms a prefetch with the rewrite, so the soft nav does not serve control', async () => {
    // A rewrite lands AT the control URL, so an un-warmed prefetch would cache
    // the CONTROL payload under exactly the key the click reads.
    const proxy = createTestaProxy({ projectId: 'acme', config: rewriteConfig(), tracking: false });
    const res = await proxy(
      new NextRequest(new URL('https://acme.com/pricing'), {
        headers: new Headers({
          rsc: '1',
          'next-router-prefetch': '1',
          'sec-fetch-mode': 'cors',
          cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
        }),
      }),
    );
    expect(res.headers.get('x-middleware-rewrite')).toContain('/pricing-v2');
  });

  it('commits nothing on a prefetch (no Set-Cookie)', async () => {
    const proxy = createTestaProxy({ projectId: 'acme', config: rewriteConfig(), tracking: false });
    const res = await proxy(
      new NextRequest(new URL('https://acme.com/pricing'), {
        headers: new Headers({
          rsc: '1',
          'next-router-prefetch': '1',
          'sec-fetch-mode': 'cors',
          cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
        }),
      }),
    );
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
