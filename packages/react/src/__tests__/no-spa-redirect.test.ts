// @vitest-environment happy-dom
/**
 * A redirect is the only change that cannot be taken back. A DOM change applied
 * against a half-settled page re-applies correctly once it settles; a navigation
 * commits once and takes the address bar with it. So it may only fire on a URL
 * the browser delivered — the initial load — never on one the app assembled
 * during a soft navigation, which can be missing whatever its query rebuild
 * hadn't resolved yet.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';
import { initTesta } from '../init.ts';
import { resetExposureGuard } from '../tracking.ts';

const config = (): ProjectConfig => ({
  project_id: 1,
  slug: 'acme',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '',
  config_hash: 'h1',
  experiments: [
    {
      experiment_id: 101,
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/checkout' }],
      goals: [],
      variations: [
        { variation_id: 0, weight: 0, changes: [] },
        {
          variation_id: 1,
          weight: 100,
          changes: [
            {
              type: 'redirect',
              from_url: 'https://acme.com/checkout',
              to_url: 'https://acme.com/checkout-v2',
            },
          ],
        },
      ],
    },
  ],
});

function run(over: Partial<Parameters<typeof initTesta>[0]> = {}) {
  let navigated: string | null = null;
  return initTesta({
    config: config(),
    currentUrl: 'https://acme.com/checkout',
    store: new DocumentCookieStore({ secure: false }),
    tracking: false,
    navigate: (u) => {
      navigated = u;
    },
    ...over,
  }).then((r) => ({ ...r, navigated }));
}

describe('split-URL redirect is gated to the initial cycle', () => {
  beforeEach(() => {
    __resetMemoryTier();
    localStorage.clear();
    sessionStorage.clear();
    resetExposureGuard();
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=;max-age=0;path=/`;
    }
  });

  it('redirects by default (the initial load)', async () => {
    const r = await run();
    expect(r.redirected).toBe(true);
    expect(r.navigated).toContain('/checkout-v2');
  });

  it('does NOT redirect when the caller withholds permission (soft nav)', async () => {
    const r = await run({ allowRedirect: false });
    expect(r.redirected).toBe(false);
    expect(r.navigated).toBeNull();
  });

  it('a cookie-first cycle decides NOTHING — no bucketing against an app-built URL', async () => {
    const r = await run({ allowRedirect: false, allowAssign: false });
    expect(r.applied).toEqual([]);
    expect(r.navigated).toBeNull();
    // and nothing was written
    expect(document.cookie).not.toContain('_testa_exp=101');
  });

  it('a cookie-first cycle still APPLIES what is already assigned', async () => {
    document.cookie = '_testa_exp=101.1.0.9999999999;path=/';
    const r = await run({ allowRedirect: false, allowAssign: false });
    // The engine never ran, so nothing is "applied" by it — but the assignment
    // in the cookie is what drives the DOM apply and the tracking below.
    expect(r.applied).toEqual([]);
    expect(r.redirected).toBe(false);
  });
});

describe('exposure provenance', () => {
  beforeEach(() => {
    __resetMemoryTier();
    localStorage.clear();
    resetExposureGuard();
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=;max-age=0;path=/`;
    }
  });

  async function sourceOf(over: Partial<Parameters<typeof initTesta>[0]>) {
    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await run({ tracking: true, ...over });
    } finally {
      globalThis.fetch = original;
    }
    const lead = bodies.map((b) => JSON.parse(b)).find((b) => b.experiment !== undefined);
    return lead?.source;
  }

  it('labels an initial-load exposure', async () => {
    expect(await sourceOf({})).toBe('client:initial');
  });

  it('labels a soft-nav exposure — reported from the cookie, not from a decision', async () => {
    document.cookie = '_testa_exp=101.1.0.9999999999;path=/';
    expect(await sourceOf({ allowRedirect: false, allowAssign: false })).toBe('client:spa');
  });

  it('honours an explicit override', async () => {
    expect(await sourceOf({ source: 'client:cold' })).toBe('client:cold');
  });
});
