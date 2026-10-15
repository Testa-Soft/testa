/**
 * Bayesian stats module (PRD-006 Part 4). Interface stub created in P0
 * (task 5.1); P3 (tasks 5.10–5.11) replaces the bodies and keeps these
 * signatures. Pure: no I/O.
 */

export type StatModel = 'beta' | 'normal';

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
  seedKey: string;
  confidence?: number;
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

const NOT_IMPLEMENTED = 'not implemented: P3';

export function computeStats(_req: StatsRequest): Map<number, VariationStats> {
  throw new Error(NOT_IMPLEMENTED);
}

export function sampleSizeTwoProportion(_a: {
  baseline: number;
  mde: number;
  alpha: number;
  power: number;
}): number {
  throw new Error(NOT_IMPLEMENTED);
}

export function srmChiSquare(
  _observed: number[],
  _weights: number[],
): { chi2: number; p_value: number } {
  throw new Error(NOT_IMPLEMENTED);
}
