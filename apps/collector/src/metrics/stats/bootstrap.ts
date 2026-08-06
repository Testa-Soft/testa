/**
 * Bootstrap CI + significance for RPV (revenue per visitor).
 *
 * RPV distributions are heavily zero-inflated, making normal approximations
 * unreliable; bootstrap percentile CIs are more honest. All randomness goes
 * through a seeded PRNG (mulberry32) so results are fully deterministic.
 */

// mulberry32 — fast seeded 32-bit PRNG.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function sum(arr: readonly number[]): number {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function resampleMean(arr: readonly number[], n: number, rng: () => number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += arr[Math.floor(rng() * n)] ?? 0;
  }
  return s / n;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BootstrapOpts {
  /** Number of bootstrap resamples. Default 2 000. */
  B?: number;
  /** PRNG seed for determinism. Default 42. */
  seed?: number;
  /** CI confidence level (0–1). Default 0.95. */
  level?: number;
  /** Significance threshold for isSignificant. Default 0.05. */
  alpha?: number;
}

export interface RpvBootstrapResult {
  /** Sample mean (point estimate). */
  point: number;
  ciLow: number;
  ciHigh: number;
}

/**
 * Percentile bootstrap CI for a single variation's RPV.
 * `perVisitorRevenue` contains one entry per exposed visitor (often mostly 0s).
 */
export function bootstrapRpv(
  perVisitorRevenue: readonly number[],
  opts: BootstrapOpts = {},
): RpvBootstrapResult {
  const { B = 2000, seed = 42, level = 0.95 } = opts;
  const rng = mulberry32(seed);
  const n = perVisitorRevenue.length;
  const point = sum(perVisitorRevenue) / n;

  const stats: number[] = Array.from({ length: B }, () => resampleMean(perVisitorRevenue, n, rng));
  stats.sort((a, b) => a - b);

  const loIdx = Math.floor(((1 - level) / 2) * B);
  const hiIdx = Math.min(Math.floor((1 - (1 - level) / 2) * B), B - 1);
  return { point, ciLow: stats[loIdx] ?? point, ciHigh: stats[hiIdx] ?? point };
}

export interface SignificanceResult {
  /** Absolute delta: meanCmp - meanRef. */
  delta: number;
  /** Relative delta: delta / |meanRef|; 0 when meanRef is 0. */
  deltaRelative: number;
  /** Two-sided bootstrap p-value. */
  pValue: number;
  isSignificant: boolean;
}

/**
 * Two-sample bootstrap significance test for RPV.
 *
 * Shifts the bootstrap delta distribution to be centred at 0 (H₀) and derives
 * a two-sided p-value as the proportion of shifted deltas that are at least as
 * extreme as the observed delta.
 */
export function bootstrapSignificance(
  refSamples: readonly number[],
  cmpSamples: readonly number[],
  opts: BootstrapOpts = {},
): SignificanceResult {
  const { B = 2000, seed = 42, alpha = 0.05 } = opts;
  const rng = mulberry32(seed);
  const nRef = refSamples.length;
  const nCmp = cmpSamples.length;

  const meanRef = sum(refSamples) / nRef;
  const meanCmp = sum(cmpSamples) / nCmp;
  const delta = meanCmp - meanRef;
  const deltaRelative = meanRef !== 0 ? delta / Math.abs(meanRef) : 0;

  const deltas: number[] = Array.from({ length: B }, () => {
    return resampleMean(cmpSamples, nCmp, rng) - resampleMean(refSamples, nRef, rng);
  });

  // Shift to H₀: delta = 0, then count how often |shifted| ≥ |observed|
  const absDelta = Math.abs(delta);
  let extreme = 0;
  for (const d of deltas) {
    if (Math.abs(d - delta) >= absDelta) extreme++;
  }
  const pValue = extreme / B;

  return { delta, deltaRelative, pValue, isSignificant: pValue < alpha };
}
