/**
 * Posterior models (PRD-006 §4.2). Each turns one variation's summed inputs
 * into `draws` samples of its metric:
 *
 * - `beta`: Beta(1 + x, 1 + n − x), flat prior on a rate.
 * - `normal`: flat-prior posterior of a mean, mean + (s / √n) · t(n − 1),
 *   from n, Σx, Σx². Used for AOV (capped), RPV, engagement and per-order /
 *   per-unit metrics. No log-normal (decided).
 * - `count` (admin v2): mean events per visitor for `count_mode: every`
 *   goals. Same flat-prior posterior of a mean over visitors, from
 *   n = visitors, sum = Σ count, sumSq = Σ count_sq_visitor. Counts are
 *   over-dispersed, so the empirical variance is used (no Poisson / Gamma).
 */
import type { StatModel, VariationInput } from './index.ts';
import type { Samplers } from './samplers.ts';

/** §5.1: 100 visitors per variation, 10 conversions / orders. */
export const MIN_N = 100;
export const MIN_EVENTS = 10;

/**
 * Below §5.1's minimums. `beta`: n is the denominator (visitors) and x the
 * conversions. `normal`: n counts the observations; it may be orders (AOV) or
 * visitors (RPV), so only the 10-observation floor applies here.
 */
export function isInsufficient(model: StatModel, v: VariationInput): boolean {
  if (model === 'beta') return v.n < MIN_N || (v.x ?? 0) < MIN_EVENTS;
  // count: n = visitors, sum = events — the same floors as a rate.
  if (model === 'count') return v.n < MIN_N || (v.sum ?? 0) < MIN_EVENTS;
  return v.n < MIN_EVENTS;
}

export function drawPosterior(
  model: StatModel,
  v: VariationInput,
  draws: number,
  s: Samplers,
): Float64Array {
  return model === 'beta' ? drawBeta(v, draws, s) : drawNormalMean(v, draws, s);
}

function drawBeta(v: VariationInput, draws: number, s: Samplers): Float64Array {
  const x = v.x ?? 0;
  const a = 1 + x;
  const b = 1 + v.n - x;
  const out = new Float64Array(draws);
  for (let i = 0; i < draws; i++) out[i] = s.beta(a, b);
  return out;
}

function drawNormalMean(v: VariationInput, draws: number, s: Samplers): Float64Array {
  const out = new Float64Array(draws);
  const { n } = v;
  if (n <= 0) return out;
  const sum = v.sum ?? 0;
  const mean = sum / n;
  if (n < 2) return out.fill(mean);
  const variance = Math.max(0, ((v.sumSq ?? 0) - (sum * sum) / n) / (n - 1));
  const se = Math.sqrt(variance / n);
  const df = n - 1;
  for (let i = 0; i < draws; i++) out[i] = mean + se * s.studentT(df);
  return out;
}
