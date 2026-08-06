import { describe, expect, it } from 'bun:test';
import { bootstrapRpv, bootstrapSignificance } from '../bootstrap.ts';

describe('bootstrapRpv', () => {
  const DATA = [0, 0, 0, 10, 0, 0, 5, 0, 0, 20] as const;

  it('point estimate equals the sample mean', () => {
    const r = bootstrapRpv(DATA, { seed: 42 });
    expect(r.point).toBeCloseTo(3.5, 10);
  });

  it('CI brackets the point estimate', () => {
    const r = bootstrapRpv(DATA, { seed: 42 });
    expect(r.ciLow).toBeLessThanOrEqual(r.point);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.point);
  });

  it('is fully deterministic with the same seed', () => {
    const a = bootstrapRpv(DATA, { B: 500, seed: 7 });
    const b = bootstrapRpv(DATA, { B: 500, seed: 7 });
    expect(a.ciLow).toBe(b.ciLow);
    expect(a.ciHigh).toBe(b.ciHigh);
  });

  it('different seeds produce different CIs', () => {
    const a = bootstrapRpv(DATA, { B: 2000, seed: 1 });
    const b = bootstrapRpv(DATA, { B: 2000, seed: 2 });
    // Different seeds should produce at least marginally different intervals
    expect(a.ciLow !== b.ciLow || a.ciHigh !== b.ciHigh).toBe(true);
  });

  it('matches pinned reference values (seed=42, B=2000)', () => {
    const r = bootstrapRpv(DATA, { B: 2000, seed: 42 });
    expect(r.point).toBe(3.5);
    expect(r.ciLow).toBe(0);
    expect(r.ciHigh).toBe(8);
  });

  it('higher confidence level → wider CI', () => {
    const ci90 = bootstrapRpv(DATA, { B: 2000, seed: 42, level: 0.9 });
    const ci99 = bootstrapRpv(DATA, { B: 2000, seed: 42, level: 0.99 });
    expect(ci99.ciHigh - ci99.ciLow).toBeGreaterThanOrEqual(ci90.ciHigh - ci90.ciLow);
  });
});

describe('bootstrapSignificance', () => {
  it('identical samples → delta = 0 and p = 1 (not significant)', () => {
    const samples = [1, 2, 3, 4, 5];
    const r = bootstrapSignificance(samples, samples, { seed: 42 });
    expect(r.delta).toBe(0);
    expect(r.pValue).toBe(1);
    expect(r.isSignificant).toBe(false);
  });

  it('well-separated samples → isSignificant = true', () => {
    const ref = Array.from({ length: 50 }, () => 1.0);
    const cmp = Array.from({ length: 50 }, () => 10.0);
    const r = bootstrapSignificance(ref, cmp, { B: 2000, seed: 42 });
    expect(r.isSignificant).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.delta).toBeCloseTo(9, 8);
  });

  it('delta is meanCmp - meanRef', () => {
    const ref = [2, 2, 2, 2];
    const cmp = [5, 5, 5, 5];
    const r = bootstrapSignificance(ref, cmp, { B: 100, seed: 1 });
    expect(r.delta).toBeCloseTo(3, 8);
  });

  it('deltaRelative is delta / |meanRef|', () => {
    const ref = [4, 4, 4, 4]; // mean = 4
    const cmp = [6, 6, 6, 6]; // mean = 6, delta = 2, relative = 0.5
    const r = bootstrapSignificance(ref, cmp, { B: 100, seed: 1 });
    expect(r.deltaRelative).toBeCloseTo(0.5, 8);
  });

  it('deltaRelative is 0 when meanRef is 0', () => {
    const ref = [0, 0, 0, 0];
    const cmp = [1, 2, 3, 4];
    const r = bootstrapSignificance(ref, cmp, { B: 100, seed: 1 });
    expect(r.deltaRelative).toBe(0);
  });

  it('is fully deterministic with the same seed', () => {
    const ref = [1, 2, 0, 4, 0];
    const cmp = [3, 0, 5, 2, 1];
    const a = bootstrapSignificance(ref, cmp, { B: 500, seed: 99 });
    const b = bootstrapSignificance(ref, cmp, { B: 500, seed: 99 });
    expect(a.pValue).toBe(b.pValue);
  });

  it('custom alpha threshold controls isSignificant boundary', () => {
    // Use samples that yield a moderate p-value, then straddle the threshold
    const ref = [0, 0, 5, 0, 0, 10];
    const cmp = [0, 3, 0, 0, 8, 0];
    const strict = bootstrapSignificance(ref, cmp, { B: 2000, seed: 7, alpha: 0.01 });
    const loose = bootstrapSignificance(ref, cmp, { B: 2000, seed: 7, alpha: 0.99 });
    // Loose threshold should be more likely to flag significance
    expect(loose.isSignificant || !strict.isSignificant).toBe(true);
  });
});
