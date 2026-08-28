/**
 * One page view must not become several visitors. A soft nav's data/RSC fetch
 * reaches the middleware just like a document load does, and each invocation is
 * a full decision — so when the visitor id cannot be read back, every fetch
 * mints another id and reports another visitor for the same human.
 */

import { UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { isNavigationRequest } from '../request-filter.ts';
import { splitUrlConfig } from './helpers.ts';

const mw = () => createTestaProxy({ projectId: 'acme', config: splitUrlConfig() });
const req = (headers: Record<string, string>) =>
  new NextRequest(new URL('https://acme.com/pricing'), { headers: new Headers(headers) });
const mintedId = (res: Response) =>
  /_testa_uuid=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

describe('isNavigationRequest', () => {
  it('is true for a document load', () => {
    expect(isNavigationRequest(new Headers({ 'sec-fetch-mode': 'navigate' }))).toBe(true);
  });
  it('is false for a framework data/RSC fetch', () => {
    expect(isNavigationRequest(new Headers({ 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isNavigationRequest(new Headers({ 'sec-fetch-mode': 'same-origin' }))).toBe(false);
  });
  it('assumes navigation when the client does not say', () => {
    expect(isNavigationRequest(new Headers())).toBe(true);
  });
});

describe('the proxy never mints an identity for a non-pageview', () => {
  it('mints on a real navigation', async () => {
    const res = await mw()(req({ 'sec-fetch-mode': 'navigate' }));
    expect(mintedId(res)).toBeTruthy();
  });

  it('does NOT mint on a data fetch from a visitor it has never seen', async () => {
    const res = await mw()(req({ 'sec-fetch-mode': 'cors' }));
    expect(mintedId(res)).toBeUndefined();
  });

  it('still decides on a data fetch for a visitor it CAN identify', async () => {
    const res = await mw()(
      req({ 'sec-fetch-mode': 'cors', cookie: `${UUID_COOKIE}=known;_testa_exp=101.2.0.0` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('three data fetches from one cookieless client yield zero new visitors', async () => {
    const proxy = mw();
    const ids = await Promise.all(
      [0, 1, 2].map(async () => mintedId(await proxy(req({ 'sec-fetch-mode': 'cors' })))),
    );
    expect(ids.filter(Boolean)).toEqual([]);
  });
});
