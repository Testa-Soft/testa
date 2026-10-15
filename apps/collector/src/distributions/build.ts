/**
 * Pure assembly of the `distributions` view (PRD-006 §6.5), mirroring the
 * oracle `generate.py distributions()`: categorical shares (payment type,
 * coupon, currency) and the order-value histogram, per variation.
 */
import type {
  ByVariation,
  CategoricalDistribution,
  CategoryBucket,
  DistributionKey,
  DistributionsResult,
  HistogramBucket,
  HistogramDistribution,
} from '@testa-platform/shared-types';
import type { DistributionEvent } from './query.ts';

export const DISTRIBUTION_KEYS: readonly DistributionKey[] = [
  'payment_type',
  'coupon',
  'currency',
  'order_value',
];
export const NO_COUPON = 'No coupon';
export const NO_PAYMENT_TYPE = '(none)';
export const MAX_COUPON_CODES = 10;
/** Default histogram: 8 bins from pooled quantiles 12.5% … 87.5%. */
const QUANTILES = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

export interface DistributionsInput {
  experimentId: number;
  from: string;
  to: string;
  reportCurrency: string;
  variations: number[];
  keys: readonly DistributionKey[];
  /** Custom bin lower bounds; default pooled quantile bins. */
  bins?: number[];
  /** p99 cap for order values (`cap_outliers`). */
  cap?: number;
  events: DistributionEvent[];
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Python's `round(x, 2)`: half to even on exact ties. */
export function round2(x: number): number {
  const s = x * 100;
  const f = Math.floor(s);
  const r = s - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(s);
  return r / 100;
}

const before = (a: DistributionEvent, b: DistributionEvent): boolean =>
  a.order[0] - b.order[0] < 0 ||
  (a.order[0] === b.order[0] &&
    (a.order[1] - b.order[1] < 0 || (a.order[1] === b.order[1] && a.visitor_id < b.visitor_id)));

/** Variation ids: config order, then any extra seen in data. */
function variationIds(input: DistributionsInput): number[] {
  const extra = [...new Set(input.events.map((e) => e.variation_id))]
    .filter((id) => !input.variations.includes(id))
    .sort((a, b) => a - b);
  return [...input.variations, ...extra];
}

interface Tally {
  count: number;
  first: DistributionEvent;
}

/** Counts per label, sorted by count desc, ties in first-seen order. */
function tally(
  events: DistributionEvent[],
  label: (e: DistributionEvent) => string,
): [string, Tally][] {
  const map = new Map<string, Tally>();
  for (const e of events) {
    const key = label(e);
    const t = map.get(key);
    map.set(
      key,
      t ? { count: t.count + 1, first: before(e, t.first) ? e : t.first } : { count: 1, first: e },
    );
  }
  return [...map].sort(
    (a, b) => b[1].count - a[1].count || (before(a[1].first, b[1].first) ? -1 : 1),
  );
}

const buckets = (rows: [string, Tally][]): CategoryBucket[] => {
  const total = rows.reduce((s, [, t]) => s + t.count, 0);
  return rows.map(([value, t]) => ({ value, count: t.count, share: round6(t.count / total) }));
};

function categorical(
  ids: number[],
  events: DistributionEvent[],
  basis: CategoricalDistribution['basis'],
  label: (e: DistributionEvent) => string,
): CategoricalDistribution {
  return {
    basis,
    by_variation: Object.fromEntries(
      ids.map((id) => [
        String(id),
        buckets(
          tally(
            events.filter((e) => e.variation_id === id),
            label,
          ),
        ),
      ]),
    ),
  };
}

/**
 * Coupons: the 10 most used codes (pooled over variations) keep their own
 * bucket; the rest fold into one `Other codes (n)` bucket, n = codes folded.
 */
function couponLabel(orders: DistributionEvent[]): (e: DistributionEvent) => string {
  const codes = tally(
    orders.filter((e) => e.coupon !== ''),
    (e) => e.coupon,
  );
  if (codes.length <= MAX_COUPON_CODES) return (e) => e.coupon || NO_COUPON;
  const kept = new Set(codes.slice(0, MAX_COUPON_CODES).map(([code]) => code));
  const other = `Other codes (${codes.length - MAX_COUPON_CODES})`;
  return (e) => (e.coupon === '' ? NO_COUPON : kept.has(e.coupon) ? e.coupon : other);
}

/** numpy `percentile` (linear) over sorted values. */
function percentile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const a = sorted[lo] as number;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] as number;
  return a + (b - a) * (pos - lo);
}

function histogram(
  ids: number[],
  orders: DistributionEvent[],
  input: DistributionsInput,
): HistogramDistribution {
  const value = (e: DistributionEvent) =>
    input.cap === undefined ? e.value : Math.min(e.value, input.cap);
  const pooled = orders.map(value).sort((a, b) => a - b);
  const bins =
    input.bins ??
    (pooled.length ? [0, ...QUANTILES.map((q) => round2(percentile(pooled, q)))] : [0]);
  const binOf = (x: number): number => {
    let i = 0;
    for (let k = 0; k < bins.length; k++) if (x >= (bins[k] as number)) i = k;
    return i;
  };
  const by_variation: ByVariation<HistogramBucket[]> = Object.fromEntries(
    ids.map((id) => {
      const values = orders.filter((e) => e.variation_id === id).map(value);
      const counts = bins.map(() => 0);
      for (const x of values) counts[binOf(x)] = (counts[binOf(x)] ?? 0) + 1;
      return [
        String(id),
        bins.map((from, i) => ({
          from,
          to: i + 1 < bins.length ? (bins[i + 1] as number) : null,
          count: counts[i] ?? 0,
          share: values.length ? round6((counts[i] ?? 0) / values.length) : null,
        })),
      ];
    }),
  );
  return { basis: 'initial orders', bins, by_variation };
}

export function buildDistributions(input: DistributionsInput): DistributionsResult {
  const ids = variationIds(input);
  const payments = input.events.filter((e) => e.kind === 'payment');
  const orders = input.events.filter((e) => e.kind === 'order');
  const build: Record<
    DistributionKey,
    () => DistributionsResult['distributions'][DistributionKey]
  > = {
    payment_type: () =>
      categorical(
        ids,
        payments,
        'add_payment_info events',
        (e) => e.payment_type || NO_PAYMENT_TYPE,
      ),
    coupon: () => categorical(ids, orders, 'initial orders', couponLabel(orders)),
    currency: () => categorical(ids, orders, 'initial orders', (e) => e.currency),
    order_value: () => histogram(ids, orders, input),
  };
  const distributions = Object.fromEntries(
    DISTRIBUTION_KEYS.filter((k) => input.keys.includes(k)).map((k) => [k, build[k]()]),
  ) as DistributionsResult['distributions'];
  return {
    experiment_id: input.experimentId,
    from: input.from,
    to: input.to,
    report_currency: input.reportCurrency,
    distributions,
  };
}
