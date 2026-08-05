import { describe, expect, it } from 'vitest';
import { type Experiment, assign, bucketOf } from '../assign.ts';
import { ASSIGNMENT_COOKIE } from '../cookie-store.ts';
import { parsePacked } from '../packed-cookie.ts';
import { memoryStore } from './memory-store.ts';

const twoWay: Experiment = {
  experiment_id: 101,
  traffic_allocation: 100,
  variations: [
    { variation_id: 1, weight: 50 },
    { variation_id: 2, weight: 50 },
  ],
};

describe('assign', () => {
  it('is deterministic for the same visitor + experiment', () => {
    const a = assign(twoWay, { visitorId: 'visitor-A' }, memoryStore());
    const b = assign(twoWay, { visitorId: 'visitor-A' }, memoryStore());
    expect(a.variationId).toBe(b.variationId);
    expect(a.isExcluded).toBe(false);
  });

  it('persists the assignment into the packed cookie', () => {
    const store = memoryStore();
    const res = assign(twoWay, { visitorId: 'visitor-A' }, store);
    const map = parsePacked(store.get(ASSIGNMENT_COOKIE));
    expect(map.get(101)?.variation).toBe(res.variationId);
    expect(map.get(101)?.excluded).toBe(false);
  });

  it('takes the sticky cookie-first path on a second call (no re-bucket)', () => {
    const store = memoryStore();
    const first = assign(twoWay, { visitorId: 'visitor-A' }, store);
    const second = assign(twoWay, { visitorId: 'visitor-A' }, store);
    expect(second.fromCookie).toBe(true);
    expect(second.variationId).toBe(first.variationId);
  });

  it('honours a stored assignment even against a differently-weighted config', () => {
    const store = memoryStore({ [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = assign(twoWay, { visitorId: 'anyone' }, store);
    expect(res.variationId).toBe(2);
    expect(res.fromCookie).toBe(true);
  });

  it('excludes when bucket falls in the excluded range WITHOUT polluting the cookie', () => {
    // traffic_allocation 0 → everyone excluded.
    const exp: Experiment = { ...twoWay, traffic_allocation: 0 };
    const store = memoryStore();
    const res = assign(exp, { visitorId: 'visitor-A' }, store);
    expect(res.isExcluded).toBe(true);
    expect(res.excludedReason).toBe('traffic_allocation');
    // No entry written — exclusion is re-derivable, not persisted.
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).has(101)).toBe(false);
  });

  it('stays excluded across calls (deterministic re-derivation, not a cookie)', () => {
    const exp: Experiment = { ...twoWay, traffic_allocation: 0 };
    const store = memoryStore();
    const first = assign(exp, { visitorId: 'visitor-A' }, store);
    const again = assign(exp, { visitorId: 'visitor-A' }, store);
    expect(first.isExcluded).toBe(true);
    expect(again.isExcluded).toBe(true);
    expect(again.fromCookie).toBe(false); // re-derived, never cached
  });

  it('excludes an experiment with no variations', () => {
    const exp: Experiment = { experiment_id: 9, traffic_allocation: 100, variations: [] };
    const res = assign(exp, { visitorId: 'visitor-A' }, memoryStore());
    expect(res.isExcluded).toBe(true);
    expect(res.excludedReason).toBe('no_variations');
  });

  it('splits ~50/50 across a large visitor population (SRM sanity)', () => {
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < 4000; i++) {
      const res = assign(twoWay, { visitorId: `visitor-${i}` }, memoryStore());
      if (res.variationId === 1) v1++;
      else if (res.variationId === 2) v2++;
    }
    const ratio = v1 / (v1 + v2);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it('splits ~50/50 among INCLUDED visitors even at partial traffic (regression)', () => {
    // traffic 40 → ~40% included; of those, control/variant must be ~50/50.
    // The old `/100` math starved the variant entirely (0%) below 100% traffic.
    const exp: Experiment = { ...twoWay, traffic_allocation: 40 };
    let v1 = 0;
    let v2 = 0;
    let excluded = 0;
    for (let i = 0; i < 6000; i++) {
      const res = assign(exp, { visitorId: `visitor-${i}` }, memoryStore());
      if (res.isExcluded) excluded++;
      else if (res.variationId === 1) v1++;
      else if (res.variationId === 2) v2++;
    }
    // Both variations get a meaningful share (variant is NOT starved).
    const includedRatio = v1 / (v1 + v2);
    expect(includedRatio).toBeGreaterThan(0.4);
    expect(includedRatio).toBeLessThan(0.6);
    // ~40% included overall.
    expect(excluded / 6000).toBeGreaterThan(0.55);
    expect(excluded / 6000).toBeLessThan(0.65);
  });

  it('bucketOf stays in [0,100)', () => {
    for (let i = 0; i < 500; i++) {
      const b = bucketOf(`v-${i}`, 101);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});
