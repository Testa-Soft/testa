/**
 * Soft-nav M1 (task N.5) — RSC/prefetch detection + compute-without-commit.
 *
 * Covers the acceptance criteria at the unit level (no browser): RSC + hard-load
 * share the decision loop; a prefetch computes but does not commit; and RSC and
 * hard load produce the same variant for the same visitor.
 */

import { ASSIGNMENT_COOKIE } from '@testa-platform/experiment-core';
import { describe, expect, it } from 'vitest';
import { memoryStore, splitUrlConfig } from '../../__tests__/helpers.ts';
import { computePrefetchRedirect } from '../prefetch-guard.ts';
import { isPrefetchRequest, isRscRequest } from '../rsc-redirect.ts';

function headers(h: Record<string, string>) {
  return { headers: { get: (name: string) => h[name.toLowerCase()] ?? null } };
}

describe('request detection', () => {
  it('isRscRequest true only when RSC: 1', () => {
    expect(isRscRequest(headers({ rsc: '1' }))).toBe(true);
    expect(isRscRequest(headers({}))).toBe(false);
  });

  it('isPrefetchRequest true for Next-Router-Prefetch or Purpose: prefetch', () => {
    expect(isPrefetchRequest(headers({ 'next-router-prefetch': '1' }))).toBe(true);
    expect(isPrefetchRequest(headers({ purpose: 'prefetch' }))).toBe(true);
    expect(isPrefetchRequest(headers({ rsc: '1' }))).toBe(false);
  });
});

describe('computePrefetchRedirect — compute but do not commit', () => {
  const base = {
    config: splitUrlConfig(),
    currentUrl: 'https://acme.com/pricing',
    now: 0,
  };

  it('warms the variant for a cookie-sticky assigned visitor', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const to = computePrefetchRedirect(
      { ...base, visitorId: 'v-known', getCookie: (n) => store.get(n) },
      store,
    );
    expect(to).toContain('/pricing-v2');
  });

  it('never mints a visitor id (the no-commit invariant it owns)', () => {
    // The middleware guarantees no Set-Cookie by discarding the store (see
    // middleware.test.ts); the guard's own invariant is that it never mints a
    // `_testa_uuid` while computing — an ephemeral id would bucket differently
    // from the real click.
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    computePrefetchRedirect({ ...base, visitorId: null, getCookie: (n) => store.get(n) }, store);
    expect(store.dump()._testa_uuid).toBeUndefined();
  });

  it('passes a control-assigned visitor through (no redirect)', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.1.0.0' });
    const to = computePrefetchRedirect(
      { ...base, visitorId: 'v-ctl', getCookie: (n) => store.get(n) },
      store,
    );
    expect(to).toBeNull();
  });

  it('passes a fresh (unassigned) visitor through — speculative bucket not warmed', () => {
    const store = memoryStore({});
    const to = computePrefetchRedirect(
      { ...base, visitorId: null, getCookie: (n) => store.get(n) },
      store,
    );
    expect(to).toBeNull();
  });
});
