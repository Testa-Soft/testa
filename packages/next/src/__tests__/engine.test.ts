import { ASSIGNMENT_COOKIE } from '@testa-platform/experiment-core';
import { describe, expect, it } from 'vitest';
import { runExperiments } from '../engine.ts';
import { memoryStore, splitUrlConfig } from './helpers.ts';

const CURRENT = 'https://acme.com/pricing';

type Store = ReturnType<typeof memoryStore>;

function run(
  store: Store,
  over: { config?: ReturnType<typeof splitUrlConfig>; url?: string; visitorId?: string } = {},
) {
  return runExperiments(
    {
      config: over.config ?? splitUrlConfig(),
      currentUrl: over.url ?? CURRENT,
      visitorId: over.visitorId ?? 'v',
      now: 1_000_000,
      getCookie: (name) => store.get(name),
    },
    store,
  );
}

describe('runExperiments', () => {
  it('redirects a visitor assigned to the redirect variation', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' }); // v2 = redirect
    const res = run(store);
    expect(res.redirectTo).toContain('/pricing-v2');
    expect(res.applied[0]).toMatchObject({ experimentId: 101, variationId: 2, redirected: true });
  });

  it('emits a variation_applied event for control (no redirect)', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.1.0.0' });
    const res = run(store);
    expect(res.redirectTo).toBeUndefined();
    expect(res.applied[0]).toMatchObject({ experimentId: 101, variationId: 1, redirected: false });
  });

  it('re-redirects a variant visitor on repeat visits (sticky, no lockout)', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const first = run(store);
    const second = run(store);
    expect(first.redirectTo).toContain('/pricing-v2');
    expect(second.redirectTo).toContain('/pricing-v2');
  });

  it('does not redirect a variant visitor already on the destination URL', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = run(store, { url: 'https://acme.com/pricing-v2' });
    expect(res.redirectTo).toBeUndefined();
  });

  it('does NOT enroll off the experiment page (page gate)', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = run(store, { url: 'https://acme.com/home' });
    expect(res.redirectTo).toBeUndefined();
    // Not on the page → no variation applied at all.
    expect(res.applied).toHaveLength(0);
  });

  it('skips excluded visitors', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.-1.1.0' }); // excluded
    const res = run(store);
    expect(res.redirectTo).toBeUndefined();
    expect(res.applied).toHaveLength(0);
  });

  it('skips paused experiments', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = run(store, { config: splitUrlConfig({ status: 'paused' }) });
    expect(res.redirectTo).toBeUndefined();
  });

  it('persists an assignment into _testa_exp for a fresh visitor', () => {
    const store = memoryStore();
    run(store, { visitorId: 'fresh' });
    expect(store.get(ASSIGNMENT_COOKIE)).toMatch(/^101\./);
  });

  it('buckets the same visitor to the same variation across independent stores', () => {
    const a = memoryStore();
    const b = memoryStore();
    run(a, { visitorId: 'same' });
    run(b, { visitorId: 'same' });
    expect(a.get(ASSIGNMENT_COOKIE)).toBe(b.get(ASSIGNMENT_COOKIE));
  });
});

describe('targeting + exclusions (entry gates only)', () => {
  const targeted = () => {
    const config = splitUrlConfig();
    config.experiments[0]!.targeting = [
      { dimension: 'utm_source', operator: 'contains', value: 'facebook' },
    ];
    return config;
  };

  it('does not enroll a FRESH visitor when targeting is not met', () => {
    const res = run(memoryStore(), { config: targeted(), url: 'https://acme.com/pricing' });
    expect(res.applied).toHaveLength(0);
  });

  it('enrolls a fresh visitor when targeting is met', () => {
    const res = run(memoryStore(), {
      config: targeted(),
      url: 'https://acme.com/pricing?utm_source=facebook',
      visitorId: 'fresh',
    });
    expect(res.applied).toHaveLength(1);
  });

  it('keeps an ALREADY-assigned visitor in even if targeting no longer matches (sticky wins)', () => {
    // Seeded packed assignment (variant) → cookie-first wins over targeting.
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = run(store, { config: targeted(), url: 'https://acme.com/pricing' }); // no utm
    expect(res.redirectTo).toContain('/pricing-v2');
  });

  it('excludes a FRESH visitor when an exclusion condition matches', () => {
    const config = splitUrlConfig();
    config.experiments[0]!.exclusions = [
      { dimension: 'utm_source', operator: 'contains', value: 'internal' },
    ];
    const res = run(memoryStore(), { config, url: 'https://acme.com/pricing?utm_source=internal' });
    expect(res.applied).toHaveLength(0);
  });
});

describe('cross-domain inbound', () => {
  it('applies a carried assignment for a cross_domain experiment', () => {
    const config = splitUrlConfig();
    config.experiments[0]!.cross_domain = true;
    // base64 of {"u":"vis","exps":[{"e":101,"v":2}]}
    const payload = btoa(JSON.stringify({ u: 'vis', exps: [{ e: 101, v: 2 }] }));
    const store = memoryStore();
    const res = run(store, {
      config,
      url: `https://acme.com/pricing?_testa_cd=${payload}`,
      visitorId: 'would-bucket-differently',
    });
    // Honored the carried variant assignment → redirect.
    expect(res.redirectTo).toContain('/pricing-v2');
  });
});
