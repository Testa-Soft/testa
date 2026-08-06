import { describe, expect, it } from 'bun:test';
import { aovConfidenceInterval, welchTTest } from '../welch.ts';

const EPS = 1e-6;

describe('welchTTest', () => {
  // Reference case: equal variance + equal n reduces to standard t, df = 2*(n-1) = 8.
  // Verified against scipy.stats.ttest_ind_from_stats(mean1=2,std1=1,nobs1=5,
  //   mean2=4,std2=1,nobs2=5, equal_var=False): t=-3.162, df=8, p=0.01335.
  it('matches reference values for equal-variance / equal-n case', () => {
    const r = welchTTest({ meanA: 2, varA: 1, nA: 5, meanB: 4, varB: 1, nB: 5 });
    expect(Math.abs(r.t - -3.162277660168379)).toBeLessThan(EPS);
    expect(Math.abs(r.df - 8)).toBeLessThan(EPS);
    expect(Math.abs(r.pValue - 0.013349063418460757)).toBeLessThan(EPS);
  });

  it('returns p = 1 when both means are identical', () => {
    const r = welchTTest({ meanA: 5, varA: 4, nA: 10, meanB: 5, varB: 4, nB: 10 });
    expect(r.t).toBe(0);
    expect(r.pValue).toBe(1);
  });

  it('returns p ≈ 0 for extremely separated means', () => {
    const r = welchTTest({ meanA: 100, varA: 1, nA: 100, meanB: 200, varB: 1, nB: 100 });
    expect(r.pValue).toBeLessThan(1e-10);
  });

  it('t statistic is signed (A < B → t < 0)', () => {
    const r = welchTTest({ meanA: 3, varA: 2, nA: 20, meanB: 7, varB: 3, nB: 20 });
    expect(r.t).toBeLessThan(0);
  });

  it('t statistic sign flips when A and B are swapped', () => {
    const args = { meanA: 5, varA: 2, nA: 30, meanB: 8, varB: 4, nB: 25 };
    const r1 = welchTTest(args);
    const r2 = welchTTest({
      meanA: args.meanB,
      varA: args.varB,
      nA: args.nB,
      meanB: args.meanA,
      varB: args.varA,
      nB: args.nA,
    });
    expect(Math.abs(r1.t + r2.t)).toBeLessThan(EPS);
    expect(Math.abs(r1.pValue - r2.pValue)).toBeLessThan(EPS);
  });

  it('unequal variances produce df less than 2*(n-1)', () => {
    // When variances differ, Welch df < pooled df
    const r = welchTTest({ meanA: 5, varA: 1, nA: 10, meanB: 7, varB: 100, nB: 10 });
    expect(r.df).toBeLessThan(2 * (10 - 1));
    expect(r.df).toBeGreaterThan(0);
  });

  it('p-value is in [0, 1]', () => {
    for (const [nA, nB, va, vb] of [
      [5, 5, 1, 1],
      [10, 20, 4, 9],
      [100, 50, 100, 25],
    ] as const) {
      const r = welchTTest({ meanA: 3, varA: va, nA, meanB: 5, varB: vb, nB });
      expect(r.pValue).toBeGreaterThanOrEqual(0);
      expect(r.pValue).toBeLessThanOrEqual(1);
    }
  });
});

describe('aovConfidenceInterval', () => {
  // Reference: t_{0.025}(24) ≈ 2.0639, se = sqrt(400/25) = 4, CI ≈ [91.74, 108.26].
  it('matches reference CI for known input', () => {
    const ci = aovConfidenceInterval(100, 400, 25, 0.95);
    expect(Math.abs(ci.low - 91.74440581059949)).toBeLessThan(1e-4);
    expect(Math.abs(ci.high - 108.25559418940051)).toBeLessThan(1e-4);
  });

  it('CI brackets the mean', () => {
    const ci = aovConfidenceInterval(50, 100, 30, 0.95);
    expect(ci.low).toBeLessThan(50);
    expect(ci.high).toBeGreaterThan(50);
  });

  it('CI is symmetric around the mean', () => {
    const ci = aovConfidenceInterval(200, 50, 40, 0.95);
    const halfWidth = (ci.high - ci.low) / 2;
    expect(Math.abs(200 - ci.low - halfWidth)).toBeLessThan(1e-8);
  });

  it('wider variance → wider interval', () => {
    const narrow = aovConfidenceInterval(10, 1, 20, 0.95);
    const wide = aovConfidenceInterval(10, 100, 20, 0.95);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it('larger n → narrower interval (all else equal)', () => {
    const small = aovConfidenceInterval(10, 9, 10, 0.95);
    const large = aovConfidenceInterval(10, 9, 100, 0.95);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('higher confidence level → wider interval', () => {
    const ci95 = aovConfidenceInterval(10, 4, 30, 0.95);
    const ci99 = aovConfidenceInterval(10, 4, 30, 0.99);
    expect(ci99.high - ci99.low).toBeGreaterThan(ci95.high - ci95.low);
  });
});
