/**
 * The server's decision line. Since the proxy stopped creating leads, this is
 * the only record of what the SERVER concluded — a lead alone can only tell you
 * what the browser reported, so a discrepancy between them was previously
 * unobservable from either side.
 */

import { UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function capture(headers: Record<string, string>, opts: Record<string, unknown> = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response('', { status: 200 });
    }),
  );
  const proxy = createTestaProxy({
    projectId: 'acme',
    config: splitUrlConfig(),
    trackingHost: 'https://crobot.example',
    ...opts,
  });
  return proxy(
    new NextRequest(new URL('https://acme.com/pricing?flow=checkout11&fbclid=abc'), {
      headers: new Headers({ 'sec-fetch-mode': 'navigate', ...headers }),
    }),
  ).then(() => {
    const hit = urls.find((u) => u.includes('/log'));
    if (!hit) return undefined;
    const data = new URL(hit).searchParams.get('data') as string;
    return JSON.parse(decodeURIComponent(escape(atob(data))));
  });
}

describe('server decision log', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default — no beacon without opting in', async () => {
    expect(await capture({ cookie: `${UUID_COOKIE}=v1` })).toBeUndefined();
  });

  it('carries the arrival URL, the destination, the uuid and what applied', async () => {
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0` },
      { logDecisions: true },
    );
    expect(d.testa).toBe('decision');
    expect(d.urlIn).toContain('flow=checkout11');
    expect(d.urlOut).toContain('/pricing-v2');
    expect(d.uuid).toBe('v1');
    expect(d.applied).toEqual([{ experiment: 101, variation: 2, first: false }]);
    expect(d.nav).toBe('document');
  });

  it('records a pass-through as urlOut:null, so non-redirects are visible too', async () => {
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1; _testa_exp=101.1.0.0` },
      { logDecisions: true },
    );
    expect(d.urlOut).toBeNull();
    expect(d.applied).toEqual([{ experiment: 101, variation: 1, first: false }]);
  });

  it('flags params the same-site Referer had and this request lost', async () => {
    const d = await capture(
      {
        cookie: `${UUID_COOKIE}=v1`,
        referer: 'https://acme.com/results?flow=checkout11&fbclid=abc&utm_source=facebook&nbt=x',
      },
      { logDecisions: true },
    );
    expect(d.dropped).toEqual(['utm_source', 'nbt']);
  });

  it('labels a framework data fetch distinctly from a document load', async () => {
    const d = await capture(
      { 'sec-fetch-mode': 'cors', cookie: `${UUID_COOKIE}=v1` },
      { logDecisions: true },
    );
    expect(d.nav).toBe('data');
  });
});
