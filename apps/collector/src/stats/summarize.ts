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
  const best = chanceToBeBest(input.draws, input.direction);
  const control = input.draws[input.controlIndex];
  if (control === undefined) throw new Error('summarize: control index out of range');
  return input.draws.map((variation, i) =>
    i === input.controlIndex
      ? { chance_to_be_best: best[i] ?? 0 }
      : { chance_to_be_best: best[i] ?? 0, ...compare(variation, control, input) },
  );
}

function chanceToBeBest(draws: Float64Array[], direction: Direction): number[] {
  const wins = new Array<number>(draws.length).fill(0);
  const total = draws[0]?.length ?? 0;
  const sign = direction === 'lower' ? -1 : 1;
  for (let d = 0; d < total; d++) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < draws.length; i++) {
      const val = sign * ((draws[i] as Float64Array)[d] as number);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    wins[bestIdx] = (wins[bestIdx] ?? 0) + 1;
  }
  return wins.map((w) => (total === 0 ? 0 : w / total));
}

type Comparison = Pick<
  VariationStats,
  'chance_to_beat_control' | 'lift' | 'lift_ci' | 'expected_loss'
>;

/**
 * Lift and loss are relative to control, so draws where control ≤ 0 (possible
 * for a Normal mean near zero) are left out of them; with none left, they are
 * omitted rather than serialised as NaN.
 */
function compare(v: Float64Array, c: Float64Array, input: SummarizeInput): Comparison {
  const lower = input.direction === 'lower';
  const lifts = new Float64Array(v.length);
  let beats = 0;
  let valid = 0;
  let liftSum = 0;
  let lossSum = 0;
  for (let d = 0; d < v.length; d++) {
    const vd = v[d] as number;
    const cd = c[d] as number;
    if (lower ? vd < cd : vd > cd) beats++;
    if (cd <= 0) continue;
    const lift = vd / cd - 1;
    lifts[valid++] = lift;
    liftSum += lift;
    lossSum += Math.max(lower ? vd - cd : cd - vd, 0) / cd;
  }
  const chance = v.length === 0 ? 0 : beats / v.length;
  if (valid === 0) return { chance_to_beat_control: chance };
  return {
    chance_to_beat_control: chance,
    lift: liftSum / valid,
    lift_ci: credibleInterval(lifts.subarray(0, valid), input.confidence),
    expected_loss: lossSum / valid,
  };
}

/**
 * Equal-tailed interval at `confidence`, linear interpolation between order
 * statistics. Uses selection (O(n)) rather than a full sort.
 */
export function credibleInterval(values: Float64Array, confidence: number): [number, number] {
  const work = Float64Array.from(values);
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
