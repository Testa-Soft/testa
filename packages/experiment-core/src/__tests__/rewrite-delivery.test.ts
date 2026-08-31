/**
 * `nav: 'rewrite'` — a split-URL variant delivered in place.
 *
 * Everything about matching and destination building is shared with the 307
 * path; what differs is that the visitor does not move. Two invariants matter
 * most here:
 *
 *   1. A host that cannot rewrite (every client surface) must NOT be handed one,
 *      and must NOT silently downgrade it to a redirect — that would move a
 *      visitor the experiment intended to keep in place.
 *   2. The assignment still stands when delivery is unavailable, so the next
 *      server-decided pageview delivers it without re-rolling.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_COOKIE } from '../cookie-store.ts';
import { runExperiments } from '../engine.ts';
import { parsePacked } from '../packed-cookie.ts';
import { memoryStore } from './memory-store.ts';

const NOW = 1_755_000_000_000;
const PAGE = 'https://acme.com/pricing';

function config(nav?: 'redirect' | 'rewrite'): ProjectConfig {
  return {
    project_id: 1,
    slug: 'acme',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'h',
    experiments: [
      {
        experiment_id: 101,
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'exact', url_pattern: PAGE }],
        goals: [],
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          {
            variation_id: 2,
            weight: 100,
            changes: [
              {
                type: 'redirect',
                from_url: PAGE,
                to_url: '/pricing-v2',
                ...(nav ? { nav } : {}),
              },
            ],
          },
        ],
      },
    ],
  };
}

function run(opts: { nav?: 'redirect' | 'rewrite'; canRewrite?: boolean; url?: string } = {}) {
  const store = memoryStore();
  const result = runExperiments(
    {
      config: config(opts.nav),
      currentUrl: opts.url ?? PAGE,
      visitorId: 'v-1',
      now: NOW,
      getCookie: (n) => store.get(n),
      debug: true,
      ...(opts.canRewrite !== undefined ? { canRewrite: opts.canRewrite } : {}),
    },
    store,
  );
  return { result, store };
}

describe('nav: rewrite on a server host', () => {
  it('returns rewriteTo, not redirectTo', () => {
    const { result } = run({ nav: 'rewrite', canRewrite: true });
    expect(result.rewriteTo).toBe('/pricing-v2');
    expect(result.redirectTo).toBeUndefined();
  });

  it('reports delivery=rewrite with the destination, and redirected=false', () => {
    const { result } = run({ nav: 'rewrite', canRewrite: true });
    const applied = result.applied[0];
    // The visitor never navigated, so `redirected` must stay false — but the
    // destination is still what they were served.
    expect(applied?.redirected).toBe(false);
    expect(applied?.delivery).toBe('rewrite');
    expect(applied?.destinationUrl).toBe('/pricing-v2');
  });

  it('traces the reason as `rewrite`', () => {
    const { result } = run({ nav: 'rewrite', canRewrite: true });
    expect(result.trace?.[0]?.reason).toBe('rewrite');
  });

  it('still writes the sticky assignment', () => {
    const { store } = run({ nav: 'rewrite', canRewrite: true });
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)?.variation).toBe(2);
  });
});

describe('nav: rewrite on a host that cannot rewrite', () => {
  it('delivers nothing — and never downgrades to a redirect', () => {
    const { result } = run({ nav: 'rewrite' }); // canRewrite omitted = client surface
    expect(result.rewriteTo).toBeUndefined();
    expect(result.redirectTo).toBeUndefined();
  });

  it('keeps the assignment so a later server pageview can deliver it', () => {
    const { result, store } = run({ nav: 'rewrite' });
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(101)?.variation).toBe(2);
    expect(result.trace?.[0]?.reason).toBe('rewrite_unavailable');
  });

  it('reports no delivery on the applied event', () => {
    const { result } = run({ nav: 'rewrite' });
    const applied = result.applied[0];
    expect(applied?.variationId).toBe(2); // still exposed — they ARE in the test
    expect(applied?.delivery).toBeUndefined();
    expect(applied?.destinationUrl).toBeUndefined();
    expect(applied?.redirected).toBe(false);
  });

  it('explicit canRewrite:false behaves the same as omitted', () => {
    const { result } = run({ nav: 'rewrite', canRewrite: false });
    expect(result.rewriteTo).toBeUndefined();
    expect(result.redirectTo).toBeUndefined();
  });
});

describe('default delivery is unchanged', () => {
  it('no `nav` field still 307s', () => {
    const { result } = run({ canRewrite: true });
    expect(result.redirectTo).toBe('/pricing-v2');
    expect(result.rewriteTo).toBeUndefined();
    expect(result.applied[0]?.redirected).toBe(true);
    expect(result.applied[0]?.delivery).toBe('redirect');
  });

  it("nav: 'redirect' is explicit but identical", () => {
    const { result } = run({ nav: 'redirect', canRewrite: true });
    expect(result.redirectTo).toBe('/pricing-v2');
    expect(result.applied[0]?.delivery).toBe('redirect');
  });

  it('a rewrite host does not affect a plain redirect experiment', () => {
    const withRewriteHost = run({ canRewrite: true }).result;
    const withoutRewriteHost = run({ canRewrite: false }).result;
    expect(withRewriteHost.redirectTo).toBe(withoutRewriteHost.redirectTo);
  });
});

describe('off-page', () => {
  it('does not deliver a rewrite where the page rule misses', () => {
    const { result } = run({ nav: 'rewrite', canRewrite: true, url: 'https://acme.com/blog' });
    expect(result.rewriteTo).toBeUndefined();
    expect(result.applied).toEqual([]);
  });
});
