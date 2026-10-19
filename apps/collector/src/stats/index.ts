/**
 * Bayesian stats module (PRD-006 Part 4, task 5.10). Signatures fixed by P0
 * (task 5.1). Pure and deterministic: no I/O, Float64Array draws.
 */
import { drawPosterior, isInsufficient } from './models.ts';
import { createRng } from './rng.ts';
import { createSamplers } from './samplers.ts';
import { summarize } from './summarize.ts';

export { sampleSizeTwoProportion, srmChiSquare } from './planning.ts';

/** See `StatModel` in shared-types: `count` = mean events per visitor (Σn, Σn²). */
export type StatModel = 'beta' | 'normal' | 'count';

export interface VariationInput {
  variation: number;
  /** Denominator: visitors, orders, units… */
  n: number;
  /** Successes (beta). */
  x?: number;
  /** Normal: Σx, Σx². */
  sum?: number;
  sumSq?: number;
}

export interface StatsRequest {
  model: StatModel;
  control: number;
  draws: number;
  /**
   * Seed prefix `${experimentId}|${metric}|${groupKey}` (PRD-006 §5.5).
   * {@link computeStats} appends `|${variation}|${n}|${x}|${sum},${sumSq}` per
   * variation (absent inputs as ''), so each variation's draws depend only on
   * its own inputs. The modeler passes real ids; the stateless
   * `POST /api/v1/stats` passes `|${metric}|` (empty experiment and group).
   */
  seedKey: string;
  /** Credible-interval level for `lift_ci`, default 0.95. */
  confidence?: number;
  /** `lower`: smaller is better (abandonment); flips beat / best / loss. */
  direction?: 'higher' | 'lower';
  variations: VariationInput[];
}

export interface VariationStats {
  chance_to_beat_control?: number;
  chance_to_be_best: number;
  lift?: number;
  lift_ci?: [number, number];
  expected_loss?: number;
  insufficient_data?: true;
}

export const DEFAULT_CONFIDENCE = 0.95;

/** Per-variation seed string; see {@link StatsRequest.seedKey}. */
export function variationSeed(seedKey: string, v: VariationInput): string {
  return `${seedKey}|${v.variation}|${v.n}|${v.x ?? ''}|${v.sum ?? ''},${v.sumSq ?? ''}`;
}

/**
 * Posterior summary per variation id. A variation is `insufficient_data` when
 * it, or control, is below the §5.1 minimums; its numbers are still returned.
 */
export function computeStats(req: StatsRequest): Map<number, VariationStats> {
  const controlIndex = req.variations.findIndex((v) => v.variation === req.control);
  if (controlIndex < 0)
    throw new RangeError(`computeStats: control ${req.control} not in variations`);
  if (!Number.isInteger(req.draws) || req.draws < 1)
    throw new RangeError('computeStats: draws must be a positive integer');

  const draws = req.variations.map((v) =>
    drawPosterior(
      req.model,
      v,
      req.draws,
      createSamplers(createRng(variationSeed(req.seedKey, v))),
    ),
  );
  const stats = summarize({
    draws,
    controlIndex,
    direction: req.direction ?? 'higher',
    confidence: req.confidence ?? DEFAULT_CONFIDENCE,
  });
  const controlShort = isInsufficient(req.model, req.variations[controlIndex] as VariationInput);
  return new Map(
    req.variations.map((v, i) => {
      const s = stats[i] as VariationStats;
      const short = isInsufficient(req.model, v) || controlShort;
      return [v.variation, short ? { ...s, insufficient_data: true as const } : s];
    }),
  );
}
