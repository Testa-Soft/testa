/**
 * Draw-by-draw comparison of posterior samples (PRD-006 §4.3): chance to beat
 * control, chance to be best, lift with a credible interval, expected loss.
 * Control gets `chance_to_be_best` only.
 */
import type { VariationStats } from './index.ts';

export type Direction = 'higher' | 'lower';

export interface SummarizeInput {
  /** One posterior sample array per variation, all the same length. */
  draws: Float64Array[];
  controlIndex: number;
  direction: Direction;
  confidence: number;
}

export function summarize(input: SummarizeInput): VariationStats[] {
  const { draws, controlIndex } = input;
  const control = draws[controlIndex];
  if (control === undefined) throw new Error('summarize: control index out of range');
  const acc = accumulate(draws, control, controlIndex, input.direction === 'lower');
  const total = control.length;
  return draws.map((_, i) => {
    const chance_to_be_best = total === 0 ? 0 : (acc.wins[i] as number) / total;
    const cmp = acc.comparisons[i];
    return cmp === undefined
      ? { chance_to_be_best }
      : { chance_to_be_best, ...finish(cmp, total, input.confidence) };
  });
}

/** Running sums for one variation vs control. */
interface Accumulator {
  beats: number;
  valid: number;
  liftSum: number;
  lossSum: number;
  lifts: Float64Array;
}

/**
 * One pass over the draws: the best variation per draw, and each variation's
 * comparison with control. Lift and loss are relative to control, so draws
 * where control ≤ 0 (possible for a Normal mean near zero) are left out of
 * them.
 */
function accumulate(
  draws: Float64Array[],
  control: Float64Array,
  controlIndex: number,
  lower: boolean,
): { wins: Float64Array; comparisons: (Accumulator | undefined)[] } {
  const k = draws.length;
  const total = control.length;
  const wins = new Float64Array(k);
  const comparisons = draws.map((_, i) =>
    i === controlIndex
      ? undefined
      : { beats: 0, valid: 0, liftSum: 0, lossSum: 0, lifts: new Float64Array(total) },
  );
  const sign = lower ? -1 : 1;
  for (let d = 0; d < total; d++) {
    const cd = control[d] as number;
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < k; i++) {
      const vd = (draws[i] as Float64Array)[d] as number;
      if (sign * vd > bestVal) {
        bestVal = sign * vd;
        bestIdx = i;
      }
      const acc = comparisons[i];
      if (acc === undefined) continue;
      if (lower ? vd < cd : vd > cd) acc.beats++;
      if (cd <= 0) continue;
      const lift = vd / cd - 1;
      acc.lifts[acc.valid++] = lift;
      acc.liftSum += lift;
      acc.lossSum += Math.max(lower ? vd - cd : cd - vd, 0) / cd;
    }
    wins[bestIdx] = (wins[bestIdx] as number) + 1;
  }
  return { wins, comparisons };
}

type Comparison = Pick<
  VariationStats,
  'chance_to_beat_control' | 'lift' | 'lift_ci' | 'expected_loss'
>;

/** With no draw where control > 0, lift and loss are omitted rather than NaN. */
function finish(acc: Accumulator, total: number, confidence: number): Comparison {
  const chance = total === 0 ? 0 : acc.beats / total;
  if (acc.valid === 0) return { chance_to_beat_control: chance };
  return {
    chance_to_beat_control: chance,
    lift: acc.liftSum / acc.valid,
    lift_ci: intervalInPlace(acc.lifts.subarray(0, acc.valid), confidence),
    expected_loss: acc.lossSum / acc.valid,
  };
}

/**
 * Equal-tailed interval at `confidence`, linear interpolation between order
 * statistics. Uses selection (O(n)) rather than a full sort.
 */
export function credibleInterval(values: Float64Array, confidence: number): [number, number] {
  return intervalInPlace(Float64Array.from(values), confidence);
}

/** As {@link credibleInterval}, reordering `work` instead of copying it. */
function intervalInPlace(work: Float64Array, confidence: number): [number, number] {
  const tail = (1 - confidence) / 2;
  return [quantile(work, tail), quantile(work, 1 - tail)];
}

/** Mutates `work`'s order (never its contents); callers pass a private copy. */
function quantile(work: Float64Array, p: number): number {
  const pos = p * (work.length - 1);
  const lo = Math.floor(pos);
  const a = select(work, lo);
  if (lo + 1 >= work.length || pos === lo) return a;
  // After select, everything right of `lo` is ≥ a; the next order statistic is their minimum.
  let b = Number.POSITIVE_INFINITY;
  for (let i = lo + 1; i < work.length; i++) b = Math.min(b, work[i] as number);
  return a + (b - a) * (pos - lo);
}

/** Hoare quickselect (median-of-three pivot): the k-th smallest, partitioning `a` around it. */
function select(a: Float64Array, k: number): number {
  let left = 0;
  let right = a.length - 1;
  while (right > left) {
    const mid = (left + right) >>> 1;
    const pivot = median3(a[left] as number, a[mid] as number, a[right] as number);
    let i = left;
    let j = right;
    while (i <= j) {
      while ((a[i] as number) < pivot) i++;
      while ((a[j] as number) > pivot) j--;
      if (i <= j) {
        const t = a[i] as number;
        a[i] = a[j] as number;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return a[k] as number;
}

const median3 = (x: number, y: number, z: number): number =>
  Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
