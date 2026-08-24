/**
 * `createTestaProxySync` through real `next/server` NextRequest/NextResponse —
 * proves the sync proxy reaches the same decisions as the async one (shared
 * core), plus its sync-specific contracts: never awaits, cold fetch-based
 * instances pass through while warming in the background, async handlers are
 * rejected loudly.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearConfigSnapshot, writeConfigSnapshot } from '../config-snapshot.ts';
import { SHIELD_HEADER } from '../constants.ts';
import { createTestaProxySync } from '../middleware-sync.ts';
import { splitUrlConfig } from './helpers.ts';

function request(url: string, opts: { cookie?: string; prefetch?: boolean; ua?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.prefetch) headers.set('next-router-prefetch', '1');
  if (opts.ua) headers.set('user-agent', opts.ua);
  return new NextRequest(new URL(url), { headers });
}

afterEach(() => {
  clearConfigSnapshot();
});

const mw = () => createTestaProxySync({ projectId: 'acme', config: splitUrlConfig() });

describe('createTestaProxySync', () => {
  it('returns a NextResponse synchronously — no Promise anywhere', () => {
    const res = mw()(request('https://acme.com/pricing'));
    expect(res).toBeInstanceOf(NextResponse);
    expect(typeof (res as unknown as { then?: unknown }).then).not.toBe('function');
  });

  it('307-redirects a redirect-variation visitor to the variant', () => {
    const res = mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('passes a control-variation visitor through without redirect', () => {
    const res = mw()(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` }),
    );
    expect(res.status).not.toBe(307);
  });

  it('mints a _testa_uuid cookie for a fresh visitor', () => {
    const res = mw()(request('https://acme.com/home'));
    expect(res.headers.get('set-cookie') ?? '').toContain('_testa_uuid=');
  });

  it('warms a prefetch redirect without committing (no Set-Cookie)', () => {
    const res = mw()(
      request('https://acme.com/pricing', {
        cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0`,
        prefetch: true,
      }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('bypasses bots without minting cookies', () => {
    const res = mw()(request('https://acme.com/pricing', { ua: 'Googlebot/2.1' }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('serves full decisions from the instrumentation snapshot without any fetch source', () => {
    writeConfigSnapshot('acme', splitUrlConfig(), Date.now());
    const proxy = createTestaProxySync({ projectId: 'acme' }); // no config/loadConfig/configUrl
    const res = proxy(
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('cold fetch-based instance: passes through unexperimented, warms in background, then serves', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const proxy = createTestaProxySync({ projectId: 'acme', loadConfig });
    const assigned = () =>
      request('https://acme.com/pricing', { cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` });

    const cold = proxy(assigned());
    expect(cold.status).not.toBe(307); // fail open, never block
    expect(loadConfig).toHaveBeenCalledTimes(1); // background warm-up kicked

    await vi.waitFor(() => {
      expect(proxy(assigned()).status).toBe(307); // warm now
    });
  });

  describe('sync handler composition', () => {
    it('runs the handler with x-testa-shield set and keeps testa cookies on its response', () => {
      const seen: Array<string | null> = [];
      const proxy = createTestaProxySync({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) => {
          seen.push(req.headers.get(SHIELD_HEADER));
          return NextResponse.next({ request: { headers: new Headers(req.headers) } });
        },
      });
      const res = proxy(request('https://acme.com/home'));
      expect(seen).toEqual(['0']); // split-URL-only config → no shield
      expect(res.headers.get('set-cookie') ?? '').toContain('_testa_uuid=');
    });

    it('a handler redirect is returned as-is', () => {
      const proxy = createTestaProxySync({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler: (req) =>
          NextResponse.redirect(new URL('/login', new URL(req.url).origin), 307),
      });
      const res = proxy(request('https://acme.com/home'));
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
    });

    it('runs the handler on bypassed requests too (API routes)', () => {
      const handler = vi.fn(() => undefined);
      const proxy = createTestaProxySync({
        projectId: 'acme',
        config: splitUrlConfig(),
        handler,
      });
      proxy(request('https://acme.com/api/users'));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('throws loudly when the handler returns a Promise', () => {
      const proxy = createTestaProxySync({
        projectId: 'acme',
        config: splitUrlConfig(),
        // Cast past the sync-only type on purpose — simulating a JS consumer.
        handler: (async () => undefined) as unknown as () => undefined,
      });
      expect(() => proxy(request('https://acme.com/home'))).toThrow('createTestaProxy');
    });
  });

  it('requires a projectId', () => {
    expect(() => createTestaProxySync({})).toThrow('projectId');
  });
});
