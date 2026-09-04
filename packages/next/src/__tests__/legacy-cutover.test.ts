/**
 * `legacyCookiesEnabled` end to end through real `next/server`.
 *
 * The unit tests in experiment-core cover the codec; what has to be proven HERE
 * is the seam — that the adoption happens BEFORE the engine reads the packed
 * cookie, so a returning 3.x visitor gets the variant their legacy cookie says
 * they were on rather than a fresh roll.
 */

import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';
import { SHIELD_HEADER } from '../constants.ts';
import { createTestaProxy } from '../middleware.ts';
import { splitUrlConfig } from './helpers.ts';

/**
 * A visitor id the v2 hash buckets to the CONTROL variation of experiment 101
 * (`bucketOf(VISITOR, 101) === 32`, below the 50/50 split). That is what makes
 * these assertions discriminating: legacy says variation 2 (redirect), a
 * re-bucket says variation 1 (pass through), so the two outcomes are visibly
 * different rather than coincidentally equal.
 */
const VISITOR = '00000000-0000-4000-8000-000000000000';

function request(url: string, cookies: Record<string, string>): NextRequest {
  const headers = new Headers();
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`);
  if (jar.length > 0) headers.set('cookie', jar.join('; '));
  return new NextRequest(new URL(url), { headers });
}

const proxy = (legacyCookiesEnabled?: boolean) =>
  createTestaProxy({
    projectSlug: 'acme',
    config: splitUrlConfig(),
    ...(legacyCookiesEnabled === undefined ? {} : { legacyCookiesEnabled }),
  });

describe('legacy cutover', () => {
  it('re-buckets a returning 3.x visitor when the flag is OFF — the failure this guards against', async () => {
    const res = await proxy()(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_101: '2' }),
    );

    // The legacy cookie said variation 2 (redirect); with the flag off it is
    // invisible and the visitor is bucketed afresh into the control.
    expect(res.status).not.toBe(307);
  });

  it('honours the legacy assignment when the flag is ON', async () => {
    const res = await proxy(true)(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_101: '2' }),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it('writes the legacy assignment into the packed cookie, so it is migrated once', async () => {
    const res = await proxy(true)(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_101: '2' }),
    );

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${ASSIGNMENT_COOKIE}=101.2.0.`);
  });

  it('keeps a legacy CONTROL visitor on the control page', async () => {
    // The half of the population a truthiness bug would silently re-roll.
    const res = await proxy(true)(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_101: '1' }),
    );

    expect(res.status).not.toBe(307);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${ASSIGNMENT_COOKIE}=101.1.0.`);
  });

  it('lets the packed cookie win over stale legacy cookies', async () => {
    const res = await proxy(true)(
      request('https://acme.com/pricing', {
        _testa_uuid: VISITOR,
        [ASSIGNMENT_COOKIE]: '101.1.0.0',
        _testa_exp_101: '2',
      }),
    );

    expect(res.status).not.toBe(307);
  });

  it('is a no-op for a visitor with no legacy cookies', async () => {
    const withFlag = await proxy(true)(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR }),
    );
    const without = await proxy()(request('https://acme.com/pricing', { _testa_uuid: VISITOR }));

    expect(withFlag.status).toBe(without.status);
  });
});

/**
 * Which HALF of the SDK adopts the legacy cookies depends on the decision mode,
 * so "does the cutover work" has to be answered per mode rather than once.
 *
 * The rule underneath: whoever DECIDES must migrate first. The proxy decides in
 * `server` and in warm `hybrid`; the client decides in `client` mode and on a
 * cold `hybrid` instance. The client half of these cases is covered in
 * `@testa-soft/react`'s own `legacy-cutover.test.ts` — here we prove the proxy
 * does the right thing at each boundary, INCLUDING correctly declining to.
 */
describe('legacy cutover across decision modes', () => {
  const legacyVisitor = () =>
    request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_101: '2' });

  it("decisions: 'server' — the proxy migrates and redirects", async () => {
    const proxy = createTestaProxy({
      projectSlug: 'acme',
      config: splitUrlConfig(),
      decisions: 'server',
      legacyCookiesEnabled: true,
    });

    const res = await proxy(legacyVisitor());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
    expect(res.headers.get('set-cookie') ?? '').toContain(`${ASSIGNMENT_COOKIE}=101.2.0.`);
  });

  it("decisions: 'hybrid' (warm) — the proxy migrates and redirects", async () => {
    const proxy = createTestaProxy({
      projectSlug: 'acme',
      config: splitUrlConfig(),
      decisions: 'hybrid',
      legacyCookiesEnabled: true,
    });

    const res = await proxy(legacyVisitor());

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/pricing-v2');
  });

  it("decisions: 'client' — the proxy migrates from the cookie jar even with no config", async () => {
    // Client mode nulls the config outright, so there is no experiment list to
    // probe — but the visitor's own cookies name the experiments they were in.
    // The proxy migrates from those and still hands the DECISION to the client,
    // shield up. The client reads the cookie set on this very response.
    const handler = vi.fn((_req: NextRequest) => NextResponse.next());
    const proxy = createTestaProxy({
      projectSlug: 'acme',
      config: splitUrlConfig(),
      decisions: 'client',
      legacyCookiesEnabled: true,
      handler,
    });

    const res = await proxy(legacyVisitor());

    expect(res.status).not.toBe(307); // the client owns the decision
    expect(res.headers.get('set-cookie') ?? '').toContain(`${ASSIGNMENT_COOKIE}=101.2.0.`);
    const seen = handler.mock.calls[0]?.[0] as NextRequest | undefined;
    expect(seen?.headers.get(SHIELD_HEADER)).toBe('1');
  });

  it("decisions: 'hybrid' on a COLD instance — migrates from the jar while the config is in flight", async () => {
    const handler = vi.fn((_req: NextRequest) => NextResponse.next());
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: (() => new Promise(() => undefined)) as never,
      decisions: 'hybrid',
      legacyCookiesEnabled: true,
      handler,
    });

    const res = await proxy(legacyVisitor());

    expect(res.status).not.toBe(307);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${ASSIGNMENT_COOKIE}=101.2.0.`);
    expect(handler.mock.calls[0]?.[0]?.headers.get(SHIELD_HEADER)).toBe('1');
  });

  it('keeps an experiment no config mentions — warm or cold, same answer', async () => {
    // Experiment 103 is in no config anywhere. The visitor keeps variation 1
    // regardless, because the migration reads their cookie jar, not a config.
    const handler = vi.fn((_req: NextRequest) => NextResponse.next());
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: (() => new Promise(() => undefined)) as never,
      legacyCookiesEnabled: true,
      handler,
    });

    const res = await proxy(
      request('https://acme.com/pricing', { _testa_uuid: VISITOR, _testa_exp_103: '1' }),
    );

    expect(res.headers.get('set-cookie') ?? '').toContain(`${ASSIGNMENT_COOKIE}=103.1.0.`);
  });

  it('a cold instance does not migrate a prefetch — speculative loads never commit', async () => {
    const headers = new Headers({
      cookie: `_testa_uuid=${VISITOR}; _testa_exp_103=1`,
      'next-router-prefetch': '1',
    });
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: (() => new Promise(() => undefined)) as never,
      legacyCookiesEnabled: true,
      handler: (_req: NextRequest) => NextResponse.next(),
    });

    const res = await proxy(new NextRequest(new URL('https://acme.com/pricing'), { headers }));

    expect(res.headers.get('set-cookie') ?? '').not.toContain(ASSIGNMENT_COOKIE);
  });

  it('a cold instance writes nothing when the flag is off', async () => {
    const proxy = createTestaProxy({
      projectId: 'acme',
      loadConfig: (() => new Promise(() => undefined)) as never,
      handler: (_req: NextRequest) => NextResponse.next(),
    });

    const res = await proxy(legacyVisitor());

    expect(res.headers.get('set-cookie') ?? '').not.toContain(ASSIGNMENT_COOKIE);
  });

  it('a prefetch never migrates — speculative loads must not commit a cookie', async () => {
    const headers = new Headers({
      cookie: `_testa_uuid=${VISITOR}; _testa_exp_101=2`,
      'next-router-prefetch': '1',
    });
    const proxy = createTestaProxy({
      projectSlug: 'acme',
      config: splitUrlConfig(),
      legacyCookiesEnabled: true,
    });

    const res = await proxy(new NextRequest(new URL('https://acme.com/pricing'), { headers }));

    expect(res.headers.get('set-cookie') ?? '').not.toContain(ASSIGNMENT_COOKIE);
  });
});
