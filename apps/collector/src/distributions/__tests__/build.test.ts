/** Distributions assembly (task 5.16): folds and edge cases the goldens don't reach. */
import { describe, expect, it } from 'bun:test';
import { type DistributionsInput, buildDistributions, round2 } from '../build.ts';
import type { DistributionEvent } from '../query.ts';

let clock = 0;
function order(over: Partial<DistributionEvent>): DistributionEvent {
  clock += 1;
  return {
    variation_id: 100,
    visitor_id: `v${clock}`,
    kind: 'order',
    payment_type: '',
    coupon: '',
    currency: 'EUR',
    value: 10,
    order: [clock, clock],
    ...over,
  };
}

const input = (
  events: DistributionEvent[],
  over: Partial<DistributionsInput> = {},
): DistributionsInput => ({
  experimentId: 1,
  from: '2026-10-01',
  to: '2026-10-03',
  reportCurrency: 'EUR',
  variations: [100, 101],
  keys: ['payment_type', 'coupon', 'currency', 'order_value'],
  events,
  ...over,
});

describe('categorical', () => {
  it('ties keep first-seen order; payment without type is (none); empty variation → []', () => {
    const events = [
      order({ coupon: 'B' }),
      order({ coupon: '' }),
      order({ coupon: 'A' }),
      order({ kind: 'payment', payment_type: '' }),
    ];
    const r = buildDistributions(input(events));
    expect(r.distributions.coupon?.by_variation['100']?.map((b) => b.value)).toEqual([
      'B',
      'No coupon',
      'A',
    ]);
    expect(r.distributions.payment_type?.by_variation['100']).toEqual([
      { value: '(none)', count: 1, share: 1 },
    ]);
    expect(r.distributions.coupon?.by_variation['101']).toEqual([]);
  });

  it('more than 10 coupon codes: top 10 pooled, the rest as "Other codes (n)"', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 12 - i }, () => order({ coupon: `C${i}` })),
    ).flat();
    const buckets = buildDistributions(input(events)).distributions.coupon?.by_variation['100'];
    expect(buckets?.map((b) => b.value)).toEqual([
      'C0',
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
      'Other codes (2)',
    ]);
    expect(buckets?.at(-1)?.count).toBe(3);
  });

  it('only the requested distributions are present', () => {
    const r = buildDistributions(input([order({})], { keys: ['currency'] }));
    expect(Object.keys(r.distributions)).toEqual(['currency']);
  });
});

describe('order_value histogram', () => {
  it('no orders → bins [0], share null', () => {
    const h = buildDistributions(input([])).distributions.order_value;
    expect(h?.bins).toEqual([0]);
    expect(h?.by_variation['100']).toEqual([{ from: 0, to: null, count: 0, share: null }]);
  });

  it('custom bins, values below the first bin land in it; the cap clamps values', () => {
    const events = [order({ value: 5 }), order({ value: 500 })];
    const h = buildDistributions(input(events, { bins: [10, 100], cap: 50 })).distributions
      .order_value;
    expect(h?.by_variation['100']?.map((b) => b.count)).toEqual([2, 0]);
  });

  it('default bins are pooled linear quantiles rounded to cents', () => {
    const events = [10, 20, 30, 40, 50, 60, 70, 80, 90].map((value) => order({ value }));
    const h = buildDistributions(input(events)).distributions.order_value;
    expect(h?.bins).toEqual([0, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('round2 is half-to-even on exact ties, like Python', () => {
    expect(round2(0.125)).toBe(0.12);
    expect(round2(0.375)).toBe(0.38);
    expect(round2(53.75)).toBe(53.75);
    expect(round2(1.006)).toBe(1.01);
  });

  it('R4 capped: counts orders above the cap per variation; zeros and threshold 0 with no orders', () => {
    const orders = [
      { variation_id: 100, value: 120 },
      { variation_id: 100, value: 50 },
      { variation_id: 101, value: 99.99 },
    ].map((o, i) => ({
      ...o,
      visitor_id: `v${i}`,
      kind: 'order' as const,
      payment_type: '',
      coupon: '',
      currency: 'EUR',
      order: [i, i] as [number, number],
    }));
    expect(buildDistributions(input(orders, { cap: 99.987, capOutliers: true })).capped).toEqual({
      threshold: 99.99,
      by_variation: { '100': 1, '101': 1 },
    });
    expect(buildDistributions(input([], { capOutliers: true })).capped).toEqual({
      threshold: 0,
      by_variation: { '100': 0, '101': 0 },
    });
    expect(buildDistributions(input(orders, { cap: 99.987 })).capped).toBeUndefined();
  });

  it('V13: shares round half-to-even like the oracle (37/128 → 0.289062, 91/128 → 0.710938)', () => {
    const payments = Array.from({ length: 128 }, (_, i) => ({
      variation_id: 100,
      visitor_id: `p${i}`,
      kind: 'payment' as const,
      payment_type: i < 37 ? 'card' : 'paypal',
      coupon: '',
      currency: 'EUR',
      value: 0,
      order: [i, i] as [number, number],
    }));
    const shares = buildDistributions(input(payments, { keys: ['payment_type'] })).distributions
      .payment_type?.by_variation['100'];
    expect(shares?.find((b) => b.value === 'card')?.share).toBe(0.289062);
    expect(shares?.find((b) => b.value === 'paypal')?.share).toBe(0.710938);
  });
});
