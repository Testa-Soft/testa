import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { describe, expect, it } from 'vitest';
import { runExperiments } from '../engine.ts';
import { domConfig, firstExperiment, memoryStore, splitUrlConfig } from './helpers.ts';

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

describe('runExperiments (client engine)', () => {
  it('flags a redirect for a visitor assigned to the redirect variation', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
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

  it('is sticky across repeat runs', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    expect(run(store).redirectTo).toContain('/pricing-v2');
    expect(run(store).redirectTo).toContain('/pricing-v2');
  });

  it('does not redirect a variant visitor already on the destination URL', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    expect(run(store, { url: 'https://acme.com/pricing-v2' }).redirectTo).toBeUndefined();
  });

  it('does NOT enroll off the experiment page (page gate)', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = run(store, { url: 'https://acme.com/home' });
    expect(res.applied).toHaveLength(0);
  });

  it('skips excluded visitors', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.-1.1.0' });
    expect(run(store).applied).toHaveLength(0);
  });

  it('skips paused experiments', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    expect(run(store, { config: splitUrlConfig({ status: 'paused' }) }).redirectTo).toBeUndefined();
  });

  it('persists a fresh assignment into _testa_exp', () => {
    const store = memoryStore();
    run(store, { visitorId: 'fresh' });
    expect(store.get(ASSIGNMENT_COOKIE)).toMatch(/^101\./);
  });

  it('buckets the same visitor identically across independent stores', () => {
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
    firstExperiment(config).targeting = [
      { dimension: 'utm_source', operator: 'contains', value: 'facebook' },
    ];
    return config;
  };

  it('does not enroll a FRESH visitor when targeting is not met', () => {
    expect(run(memoryStore(), { config: targeted() }).applied).toHaveLength(0);
  });

  it('enrolls a fresh visitor when targeting is met', () => {
    const res = run(memoryStore(), {
      config: targeted(),
      url: 'https://acme.com/pricing?utm_source=facebook',
      visitorId: 'fresh',
    });
    expect(res.applied).toHaveLength(1);
  });

  it('keeps an ALREADY-assigned visitor in even if targeting no longer matches', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    expect(run(store, { config: targeted() }).redirectTo).toContain('/pricing-v2');
  });

  it('excludes a FRESH visitor when an exclusion matches', () => {
    const config = splitUrlConfig();
    firstExperiment(config).exclusions = [
      { dimension: 'utm_source', operator: 'contains', value: 'internal' },
    ];
    const res = run(memoryStore(), { config, url: 'https://acme.com/pricing?utm_source=internal' });
    expect(res.applied).toHaveLength(0);
  });
});

describe('cross-domain inbound', () => {
  it('applies a carried assignment for a cross_domain experiment', () => {
    const config = splitUrlConfig();
    firstExperiment(config).cross_domain = true;
    const payload = btoa(JSON.stringify({ u: 'vis', exps: [{ e: 101, v: 2 }] }));
    const res = run(memoryStore(), {
      config,
      url: `https://acme.com/pricing?_testa_cd=${payload}`,
      visitorId: 'would-bucket-differently',
    });
    expect(res.redirectTo).toContain('/pricing-v2');
  });
});

describe('DOM-only experiments (assigned, no redirect)', () => {
  it('assigns + writes the cookie without redirecting', () => {
    const store = memoryStore();
    const res = run(store, { config: domConfig() });
    expect(res.redirectTo).toBeUndefined();
    expect(res.applied[0]).toMatchObject({ experimentId: 101, variationId: 2, redirected: false });
    expect(store.get(ASSIGNMENT_COOKIE)).toContain('101');
  });
});

describe('page-rule match modes', () => {
  it('not_contains excludes matching URLs', () => {
    const config = splitUrlConfig();
    firstExperiment(config).rules = [{ match_type: 'not_contains', url_pattern: 'pricing' }];
    // On /pricing → not_contains 'pricing' is false → no enrollment.
    expect(run(memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' }), { config }).applied).toHaveLength(
      0,
    );
  });

  it('contains matches a substring', () => {
    const config = splitUrlConfig();
    firstExperiment(config).rules = [{ match_type: 'contains', url_pattern: 'pric' }];
    expect(run(memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' }), { config }).applied).toHaveLength(
      1,
    );
  });
});
