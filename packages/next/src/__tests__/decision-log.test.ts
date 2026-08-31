/**
 * The server's decision line — emitted for REDIRECTS only. Since the proxy
 * stopped creating leads, this is the only record of where the SERVER sent
 * someone; a lead alone can only tell you what the browser reported, so a
 * discrepancy between them was previously unobservable from either side.
 * Pass-throughs are deliberately not logged (see `logDecisions`).
 */

import { UUID_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function capture(
  headers: Record<string, string>,
  opts: Record<string, unknown> = {},
  requestUrl = 'https://acme.com/pricing?flow=checkout11&fbclid=abc',
) {
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
    new NextRequest(new URL(requestUrl), {
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
    expect(d.urlEval).toContain('flow=checkout11');
    expect(d.urlOut).toContain('/pricing-v2');
    expect(d.uuid).toBe('v1');
    expect(d.applied).toEqual([{ experiment: 101, variation: 2, first: false }]);
    expect(d.nav).toBe('document');
  });

  it('records the URL the ENGINE evaluated, not just the one off the wire', async () => {
    // Behind an ingress that rewrites Host, `req.url` is an internal origin.
    // The decision is made against the RECOVERED public URL, and the log has to
    // show that one — otherwise the line cannot explain its own outcome.
    const d = await capture(
      {
        cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
        'x-forwarded-host': 'acme.com',
        'x-forwarded-proto': 'https',
      },
      { logDecisions: true },
      'http://localhost:5000/pricing?flow=checkout11',
    );

    expect(d.urlIn).toContain('localhost:5000'); // what arrived
    expect(d.urlEval).toContain('https://acme.com/pricing'); // what was matched
    expect(d.urlEval).not.toContain('localhost:5000');
    expect(d.urlSource).toBe('x-forwarded-host');
  });

  it('names `request-url` when nothing recovered the public host', async () => {
    // The failure mode worth seeing: rules matched the INTERNAL origin because
    // no forwarding header (or `publicHost`) supplied a better one. Here the
    // config's rule happens to be written against localhost, so it still fires.
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0` },
      {
        logDecisions: true,
        config: splitUrlConfig({
          from: 'http://localhost:5000/pricing',
          to: 'http://localhost:5000/pricing-v2',
        }),
      },
      'http://localhost:5000/pricing?flow=checkout11',
    );

    expect(d.urlEval).toContain('localhost:5000');
    expect(d.urlSource).toBe('request-url');
  });

  it('an unrecovered internal host matches a public-URL rule against nothing', async () => {
    // Same request, but the rule is written against the real public URL — the
    // engine never sees `acme.com`, so nothing matches and nothing is logged.
    // This is what a mangled `Host` looks like from the outside: silence.
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0` },
      { logDecisions: true },
      'http://localhost:5000/pricing?flow=checkout11',
    );
    expect(d).toBeUndefined();
  });

  it('does NOT log a pass-through — redirects only', async () => {
    // Variation 1 is the control (no redirect): the request goes through
    // untouched and must produce no line at all.
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1; _testa_exp=101.1.0.0` },
      { logDecisions: true },
    );
    expect(d).toBeUndefined();
  });

  it('does NOT log a pageview that matched nothing', async () => {
    const d = await capture(
      { cookie: `${UUID_COOKIE}=v1` },
      { logDecisions: true },
      'https://acme.com/upsell/pills',
    );
    expect(d).toBeUndefined();
  });

  it('flags params the same-site Referer had and this request lost', async () => {
    const d = await capture(
      {
        cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0`,
        referer: 'https://acme.com/results?flow=checkout11&fbclid=abc&utm_source=facebook&nbt=x',
      },
      { logDecisions: true },
    );
    expect(d.dropped).toEqual(['utm_source', 'nbt']);
  });

  it('labels a framework data fetch distinctly from a document load', async () => {
    const d = await capture(
      { 'sec-fetch-mode': 'cors', cookie: `${UUID_COOKIE}=v1; _testa_exp=101.2.0.0` },
      { logDecisions: true },
    );
    expect(d.nav).toBe('data');
  });
});
