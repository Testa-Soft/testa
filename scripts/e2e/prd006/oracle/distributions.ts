/**
 * generate.py `distributions()`: payment type / coupon / currency shares and
 * the initial-order value histogram, per variation.
 */

import type { Model } from './model.ts';
import { fx } from './model.ts';
import { npPercentile, pyRound, pyTruthy, r6 } from './pymath.ts';

/** Default bin edges: 0 + the 12.5 … 87.5 percentiles of all order values. */
const BIN_PERCENTILES = [12.5, 25, 37.5, 50, 62.5, 75, 87.5] as const;

export interface DistributionsOptions {
  readonly bins?: readonly number[];
}

type Counts = Map<string, Map<string, number>>;

interface ShareRow {
  readonly value: string;
  readonly count: number;
  readonly share: number | null;
}

interface HistBin {
  readonly from: number;
  readonly to: number | null;
  readonly count: number;
  readonly share: number | null;
}

function emptyCounts(m: Model): Counts {
  return new Map(m.variations.map((v) => [String(v), new Map<string, number>()]));
}

function bump(c: Counts, v: string, key: string): void {
  const inner = c.get(v);
  if (!inner) throw new Error(`oracle: variation ${v} not in model variations`);
  inner.set(key, (inner.get(key) ?? 0) + 1);
}

function fmt(d: Counts): Record<string, ShareRow[]> {
  const out: Record<string, ShareRow[]> = {};
  for (const [v, c] of d) {
    let tot = 0;
    for (const n of c.values()) tot += n;
    out[v] = [...c]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count, share: r6(count / tot) }));
  }
  return out;
}

function binIndex(x: number, bins: readonly number[]): number {
  let best = -1;
  bins.forEach((b, i) => {
    if (x >= b) best = Math.max(best, i);
  });
  if (best < 0) throw new Error(`oracle: value ${x} below the first bin`);
  return best;
}

function histogram(l: readonly number[], bins: readonly number[]): HistBin[] {
  const cnt = bins.map(() => 0);
  for (const x of l) {
    const i = binIndex(x, bins);
    cnt[i] = (cnt[i] ?? 0) + 1;
  }
  return bins.map((b, i) => ({
    from: b,
    to: bins[i + 1] ?? null,
    count: cnt[i] ?? 0,
    share: l.length > 0 ? r6((cnt[i] ?? 0) / l.length) : null,
  }));
}

export function distributions(m: Model, opts: DistributionsOptions = {}) {
  const D = { payment_type: emptyCounts(m), coupon: emptyCounts(m), currency: emptyCounts(m) };
  const vals = new Map<string, number[]>(m.variations.map((v) => [String(v), []]));
  for (const [vid, es] of m.att) {
    const x = m.exposed.get(vid);
    if (!x) throw new Error(`oracle: attributed visitor ${vid} not exposed`);
    const v = String(x.variationId);
    for (const e of es) {
      if (e.event_name === 'add_payment_info') {
        const pt = 'payment_type' in e.props ? (e.props.payment_type ?? '') : '(none)';
        bump(D.payment_type, v, pt);
      }
      if (e.event_name === 'purchase' && e.purchase_type === 'initial') {
        const coupon = e.props.coupon;
        bump(D.coupon, v, pyTruthy(coupon) && coupon !== undefined ? coupon : 'No coupon');
        bump(D.currency, v, e.currency);
        vals.get(v)?.push(e.value_native * fx(e.currency));
      }
    }
  }
  const allv = [...vals.values()].flat().sort((a, b) => a - b);
  const bins =
    opts.bins ??
    (allv.length > 0 ? [0, ...BIN_PERCENTILES.map((q) => pyRound(npPercentile(allv, q), 2))] : [0]);
  const hist: Record<string, HistBin[]> = {};
  for (const [v, l] of vals) hist[v] = histogram(l, bins);
  return {
    experiment_id: m.expId,
    from: m.from,
    to: m.to,
    report_currency: m.ccy,
    distributions: {
      payment_type: { basis: 'add_payment_info events', by_variation: fmt(D.payment_type) },
      coupon: { basis: 'initial orders', by_variation: fmt(D.coupon) },
      currency: { basis: 'initial orders', by_variation: fmt(D.currency) },
      order_value: { basis: 'initial orders', bins: [...bins], by_variation: hist },
    },
  };
}
