/**
 * The latency contract, CI-enforced:
 *   1. PARITY — both proxy flavors reach identical decisions from the same
 *      request + config (they share proxy-core; this pins it).
 *   2. PERF — the sync proxy's decision cost stays in microsecond territory;
 *      a slow addition to the pipeline fails this build, not a customer's p99.
 *   3. TIMING — the opt-in Server-Timing entry is emitted (and composes by
 *      appending), so clients can verify the cost in their own devtools/APM.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';
import { createTestaProxySync } from '../middleware-sync.ts';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

function request(url: string, cookie?: string): NextRequest {
  const headers = new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/126' });
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new URL(url), { headers });
}

const OPTS = { projectId: 'acme', config: splitUrlConfig(), tracking: false } as const;

describe('parity: sync and async proxies decide identically', () => {
  const CASES: Array<{ name: string; url: string; cookie?: string }> = [
    { name: 'variant redirect', url: 'https://acme.com/pricing', cookie: `${ASSIGNMENT_COOKIE}=101.2.0.0` },
    { name: 'control pass', url: 'https://acme.com/pricing', cookie: `${ASSIGNMENT_COOKIE}=101.1.0.0` },
    { name: 'fresh visitor off-page', url: 'https://acme.com/home' },
    { name: 'bypassed api route', url: 'https://acme.com/api/users' },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      const asyncRes = await createTestaProxy(OPTS)(request(c.url, c.cookie));
      const syncRes = createTestaProxySync(OPTS)(request(c.url, c.cookie));
      expect(syncRes.status).toBe(asyncRes.status);
      expect(syncRes.headers.get('location')).toBe(asyncRes.headers.get('location'));
      // Cookie SET/NOT-SET must agree (values may differ — minted uuids are random).
      expect(Boolean(syncRes.headers.get('set-cookie'))).toBe(
        Boolean(asyncRes.headers.get('set-cookie')),
      );
    });
  }
});

describe('perf: the sync proxy decision cost', () => {
  it('stays far under 1ms per request (2000 decisions)', () => {
    const proxy = createTestaProxySync(OPTS);
    // Warm up (JIT, module caches).
    for (let i = 0; i < 100; i++) proxy(request('https://acme.com/pricing'));

    const N = 2000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      proxy(request('https://acme.com/pricing', `${ASSIGNMENT_COOKIE}=101.2.0.0`));
    }
    const avgMs = (performance.now() - start) / N;
    // Generous CI bound — typical is ~0.01-0.05ms; regression = something slow
    // (sync I/O, heavy parsing) crept into the hot path.
    expect(avgMs).toBeLessThan(1);
  });
});

describe('timing: opt-in Server-Timing entry', () => {
  it('appends testa;dur=<ms> on redirects and pass-throughs (sync)', () => {
    const proxy = createTestaProxySync({ ...OPTS, timing: true });
    const redirect = proxy(request('https://acme.com/pricing', `${ASSIGNMENT_COOKIE}=101.2.0.0`));
    expect(redirect.headers.get('server-timing')).toMatch(/testa;dur=\d/);
    const pass = proxy(request('https://acme.com/home'));
    expect(pass.headers.get('server-timing')).toMatch(/testa;dur=\d/);
  });

  it('appends on the async proxy too, and is absent by default', async () => {
    const timed = await createTestaProxy({ ...OPTS, timing: true })(
      request('https://acme.com/home'),
    );
    expect(timed.headers.get('server-timing')).toMatch(/testa;dur=\d/);
    const untimed = await createTestaProxy(OPTS)(request('https://acme.com/home'));
    expect(untimed.headers.get('server-timing')).toBeNull();
  });
});
