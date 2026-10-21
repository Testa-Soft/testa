/** Stats module (task 5.10): F3 goldens (006-validation V7 / V15), determinism, models. */
import { describe, expect, it } from 'bun:test';
import {
  type StatsRequest,
  computeStats,
  sampleSizeTwoProportion,
  srmChiSquare,
  variationSeed,
} from '../index.ts';
import { drawPosterior, isInsufficient } from '../models.ts';
import { inverseNormalCdf, upperRegularizedGamma } from '../planning.ts';
import { createRng, hashSeed } from '../rng.ts';
import { createSamplers } from '../samplers.ts';
import { credibleInterval, summarize } from '../summarize.ts';

const F3: StatsRequest = {
  model: 'beta',
  control: 100,
  draws: 100_000,
  seedKey: '|purchase|',
  variations: [
    { variation: 100, n: 4737, x: 115 },
    { variation: 101, n: 4790, x: 137 },
    { variation: 102, n: 4702, x: 109 },
  ],
};

const mean = (a: Float64Array): number => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a: Float64Array): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

describe('hashSeed is xxhash32 (seed 0), same as experiment-core', () => {
  // Reference vectors (xxHash spec / python-xxhash docs), cross-checked
  // against packages/experiment-core/src/xxhash.ts `xxhash32(s, 0)`.
  it.each([
    ['', 0x02cc5d05],
    ['a', 0x550d7456],
    ['abc', 0x32d153ff],
    ['Nobody inspects the spammish repetition', 0xe2293b2f],
    ['|purchase||101|4790|137|,', 0xf347bc29],
  ])('%p → %d', (input, expected) => {
    expect(hashSeed(input)).toBe(expected);
  });
});

describe('rng + samplers', () => {
  it('same key → same stream; different key → different stream', () => {
    const a = createRng('k');
    const b = createRng('k');
    const c = createRng('k2');
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
  });

  it('uniforms stay in (0, 1) with mean ½', () => {
    const rng = createRng('u');
    const xs = Float64Array.from({ length: 50_000 }, () => rng.next());
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 2);
  });

  it('gamma, beta, normal and t have the right moments', () => {
    const s = createSamplers(createRng('moments'));
    const n = 50_000;
    const g = Float64Array.from({ length: n }, () => s.gamma(3.5));
    expect(mean(g)).toBeCloseTo(3.5, 1);
    const gSmall = Float64Array.from({ length: n }, () => s.gamma(0.4));
    expect(mean(gSmall)).toBeCloseTo(0.4, 1);
    const b = Float64Array.from({ length: n }, () => s.beta(2, 6));
    expect(mean(b)).toBeCloseTo(0.25, 2);
    const z = Float64Array.from({ length: n }, () => s.normal());
    expect(mean(z)).toBeCloseTo(0, 1);
    expect(sd(z)).toBeCloseTo(1, 1);
    const t = Float64Array.from({ length: n }, () => s.studentT(5));
    expect(sd(t)).toBeCloseTo(Math.sqrt(5 / 3), 1);
  });
});

describe('computeStats — F3 golden (V7)', () => {
  const out = computeStats(F3);

  it('variation 101: chance to beat 0.907 ± 0.005, best 0.876 ± 0.005', () => {
    const v = out.get(101);
    expect(v?.chance_to_beat_control).toBeGreaterThanOrEqual(0.902);
    expect(v?.chance_to_beat_control).toBeLessThanOrEqual(0.912);
    expect(v?.chance_to_be_best).toBeGreaterThanOrEqual(0.871);
    expect(v?.chance_to_be_best).toBeLessThanOrEqual(0.881);
    expect(v?.lift).toBeCloseTo(0.187, 1);
    expect(v?.lift_ci?.[0]).toBeLessThan(0);
    expect(v?.lift_ci?.[1]).toBeGreaterThan(0.4);
    expect(v?.expected_loss).toBeGreaterThan(0);
    expect(v?.insufficient_data).toBeUndefined();
  });

  it('control carries chance_to_be_best only; best sums to 1', () => {
    expect(Object.keys(out.get(100) ?? {})).toEqual(['chance_to_be_best']);
    const total = [...out.values()].reduce((s, v) => s + v.chance_to_be_best, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('identical input → byte-identical output', () => {
    const again = computeStats(F3);
    expect(JSON.stringify([...again])).toBe(JSON.stringify([...out]));
  });

  it('a variation’s draws depend only on its own inputs', () => {
    const v = F3.variations[1] as (typeof F3.variations)[number];
    expect(variationSeed('|purchase|', v)).toBe('|purchase||101|4790|137|,');
    const a = drawPosterior('beta', v, 10, createSamplers(createRng(variationSeed('|p|', v))));
    const b = drawPosterior('beta', v, 10, createSamplers(createRng(variationSeed('|p|', v))));
    expect(a).toEqual(b);
  });

  it('control: 101 flips the reference', () => {
    const flipped = computeStats({ ...F3, control: 101 });
    expect(Object.keys(flipped.get(101) ?? {})).toEqual(['chance_to_be_best']);
    const c100 = flipped.get(100)?.chance_to_beat_control ?? 1;
    expect(c100).toBeGreaterThanOrEqual(0.088);
    expect(c100).toBeLessThanOrEqual(0.098);
  });

  it('confidence narrows lift_ci', () => {
    const wide = computeStats(F3).get(101)?.lift_ci as [number, number];
    const narrow = computeStats({ ...F3, confidence: 0.8 }).get(101)?.lift_ci as [number, number];
    expect(narrow[0]).toBeGreaterThan(wide[0]);
    expect(narrow[1]).toBeLessThan(wide[1]);
  });

  it("direction 'lower' flips chance to beat and best", () => {
    const lower = computeStats({ ...F3, direction: 'lower' });
    const beat = lower.get(101)?.chance_to_beat_control ?? 0;
    expect(beat).toBeGreaterThanOrEqual(0.088);
    expect(beat).toBeLessThanOrEqual(0.098);
    expect(lower.get(102)?.chance_to_be_best).toBeGreaterThan(0.5);
  });

  it('rejects an unknown control and bad draws', () => {
    expect(() => computeStats({ ...F3, control: 999 })).toThrow(RangeError);
    expect(() => computeStats({ ...F3, draws: 0 })).toThrow(RangeError);
  });
});

describe('insufficient_data (§5.1)', () => {
  it('beta: < 100 visitors or < 10 conversions', () => {
    expect(isInsufficient('beta', { variation: 1, n: 99, x: 50 })).toBe(true);
    expect(isInsufficient('beta', { variation: 1, n: 500, x: 9 })).toBe(true);
    expect(isInsufficient('beta', { variation: 1, n: 100, x: 10 })).toBe(false);
    // More conversions than its base (an open-funnel step with a tracking gap)
    // is not a rate: no verdict.
    expect(isInsufficient('beta', { variation: 1, n: 277, x: 342 })).toBe(true);
  });

  it('normal: < 10 observations', () => {
    expect(isInsufficient('normal', { variation: 1, n: 9, sum: 90, sumSq: 900 })).toBe(true);
    expect(isInsufficient('normal', { variation: 1, n: 10, sum: 90, sumSq: 900 })).toBe(false);
  });

  it('flags the short variation, and every variation when control is short', () => {
    const short = computeStats({
      ...F3,
      draws: 2000,
      variations: [F3.variations[0], { variation: 101, n: 80, x: 4 }].filter(
        (v) => v !== undefined,
      ),
    });
    expect(short.get(101)?.insufficient_data).toBe(true);
    expect(short.get(100)?.insufficient_data).toBeUndefined();
    const shortControl = computeStats({
      ...F3,
      draws: 2000,
      variations: [{ variation: 100, n: 50, x: 3 }, ...F3.variations.slice(1)],
    });
    expect(shortControl.get(101)?.insufficient_data).toBe(true);
    expect(shortControl.get(101)?.chance_to_beat_control).toBeDefined();
  });
});

describe('normal model', () => {
  // Skewed order values: log-normal-ish, μ = 4.2, σ = 0.6 on the log scale.
  const orders = (() => {
    const s = createSamplers(createRng('orders'));
    return Float64Array.from({ length: 400 }, () => Math.exp(4.2 + 0.6 * s.normal()));
  })();
  const n = orders.length;
  const sum = orders.reduce((a, v) => a + v, 0);
  const sumSq = orders.reduce((a, v) => a + v * v, 0);

  it('recovers the sample mean and its standard error (≥ 200 orders)', () => {
    const draws = drawPosterior(
      'normal',
      { variation: 1, n, sum, sumSq },
      100_000,
      createSamplers(createRng('recovery')),
    );
    const sampleMean = sum / n;
    const se = Math.sqrt((sumSq - (sum * sum) / n) / (n - 1) / n);
    expect(Math.abs(mean(draws) - sampleMean) / sampleMean).toBeLessThan(0.002);
    expect(Math.abs(sd(draws) - se) / se).toBeLessThan(0.02);
    // True mean exp(μ + σ²/2) sits inside the 95% interval.
    const [lo, hi] = credibleInterval(draws, 0.95);
    const truth = Math.exp(4.2 + 0.18);
    expect(lo).toBeLessThan(truth);
    expect(hi).toBeGreaterThan(truth);
  });

  it('per-order metric (basket size): a bigger mean wins', () => {
    const out = computeStats({
      model: 'normal',
      control: 1,
      draws: 20_000,
      seedKey: 'e|basket_size|',
      variations: [
        { variation: 1, n: 300, sum: 600, sumSq: 1500 },
        { variation: 2, n: 300, sum: 690, sumSq: 1800 },
      ],
    });
    expect(out.get(2)?.chance_to_beat_control).toBeGreaterThan(0.95);
    expect(out.get(2)?.lift).toBeCloseTo(0.15, 1);
  });

  it('degenerate inputs give finite numbers, never NaN', () => {
    const out = computeStats({
      model: 'normal',
      control: 1,
      draws: 1000,
      seedKey: '|rpv|',
      variations: [
        { variation: 1, n: 0 },
        { variation: 2, n: 1, sum: 5, sumSq: 25 },
      ],
    });
    expect(JSON.stringify([...out])).not.toContain('null');
    expect(out.get(2)?.lift).toBeUndefined();
    expect(out.get(2)?.insufficient_data).toBe(true);
  });
});

describe('summarize', () => {
  it('expected loss is the mean relative shortfall vs control', () => {
    const [, v] = summarize({
      draws: [Float64Array.of(1, 1), Float64Array.of(0.5, 2)],
      controlIndex: 0,
      direction: 'higher',
      confidence: 0.95,
    });
    expect(v?.chance_to_beat_control).toBe(0.5);
    expect(v?.expected_loss).toBe(0.25);
    expect(v?.lift).toBe(0.25);
  });
});

describe('credibleInterval', () => {
  it('matches sort-based interpolated quantiles, without mutating its input', () => {
    const rng = createRng('ci');
    const values = Float64Array.from({ length: 10_001 }, () => rng.next() - 0.5);
    const copy = Float64Array.from(values);
    const sorted = Float64Array.from(values).sort();
    const q = (p: number): number => {
      const pos = p * (sorted.length - 1);
      const lo = Math.floor(pos);
      const a = sorted[lo] as number;
      return a + ((sorted[Math.min(lo + 1, sorted.length - 1)] as number) - a) * (pos - lo);
    };
    for (const conf of [0.95, 0.9, 0.8, 0.5]) {
      const [lo, hi] = credibleInterval(values, conf);
      expect(lo).toBe(q((1 - conf) / 2));
      expect(hi).toBe(q(1 - (1 - conf) / 2));
    }
    expect(values).toEqual(copy);
    expect(credibleInterval(Float64Array.of(3), 0.95)).toEqual([3, 3]);
  });
});

describe('planning + SRM (V15)', () => {
  it('sample size: baseline 0.024277, mde 0.15, α 0.05, power 0.8 → 30,084 ± 1', () => {
    const n = sampleSizeTwoProportion({ baseline: 0.024277, mde: 0.15, alpha: 0.05, power: 0.8 });
    expect(Math.abs(n - 30_084)).toBeLessThanOrEqual(1);
  });

  it('sample size rejects impossible rates', () => {
    expect(() =>
      sampleSizeTwoProportion({ baseline: 0.9, mde: 0.2, alpha: 0.05, power: 0.8 }),
    ).toThrow(RangeError);
  });

  it('SRM: [4737, 4790, 4702], ⅓ each → χ² 0.8277, p 0.6611', () => {
    const { chi2, p_value } = srmChiSquare([4737, 4790, 4702], [1 / 3, 1 / 3, 1 / 3]);
    expect(Math.abs(chi2 - 0.8277)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(p_value - 0.6611)).toBeLessThanOrEqual(0.001);
  });

  it('SRM rejects mismatched input', () => {
    expect(() => srmChiSquare([1, 2], [1])).toThrow(RangeError);
  });

  it('inverse normal CDF and Q(s, x) match reference values', () => {
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959963985, 8);
    expect(inverseNormalCdf(0.8)).toBeCloseTo(0.841621234, 8);
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.090232306, 8);
    // df = 4: Q(2, x) = e^-x (1 + x).
    expect(upperRegularizedGamma(2, 3)).toBeCloseTo(Math.exp(-3) * 4, 12);
    expect(upperRegularizedGamma(2, 0.5)).toBeCloseTo(Math.exp(-0.5) * 1.5, 12);
  });
});

describe('beta inputs with more conversions than their base', () => {
  it('flags every variation insufficient and still draws finite rates', () => {
    const stats = computeStats({
      model: 'beta',
      control: 0,
      seedKey: 'x-over-n',
      draws: 2000,
      variations: [
        { variation: 0, n: 277, x: 342 },
        { variation: 1, n: 314, x: 383 },
      ],
    });
    for (const s of stats.values()) {
      expect(s.insufficient_data).toBe(true);
      expect(Number.isFinite(s.chance_to_be_best)).toBe(true);
    }
  });
});
