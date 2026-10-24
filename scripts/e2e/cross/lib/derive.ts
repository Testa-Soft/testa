/**
 * Sum daily rows over a range and derive the PRD-006 §2.3 / §6.2 ratios —
 * the same arithmetic crobot's MetricDeriver must do. Written from the PRD
 * formulas, independent of both codebases under test.
 */

export interface RowLike {
  readonly date: string;
  readonly variation_id: number;
  readonly metric_key: string;
  readonly visitors: number;
  readonly converted: number;
  readonly count: number;
  readonly sum: number;
}

export interface Summed {
  readonly converted: number;
  readonly count: number;
  readonly sum: number;
}

export interface VariationSums {
  readonly visitors: number;
  readonly keys: ReadonlyMap<string, Summed>;
}

const ZERO: Summed = { converted: 0, count: 0, sum: 0 };

/** Σ rows per variation. Visitors are per (date, variation), equal on every key's row. */
export function sumByVariation(rows: readonly RowLike[]): Map<number, VariationSums> {
  const visitorsByDate = new Map<string, number>();
  const keys = new Map<number, Map<string, Summed>>();
  for (const r of rows) {
    visitorsByDate.set(`${r.variation_id}|${r.date}`, r.visitors);
    const perVar = keys.get(r.variation_id) ?? new Map<string, Summed>();
    const prev = perVar.get(r.metric_key) ?? ZERO;
    perVar.set(r.metric_key, {
      converted: prev.converted + r.converted,
      count: prev.count + r.count,
      sum: prev.sum + r.sum,
    });
    keys.set(r.variation_id, perVar);
  }
  const out = new Map<number, VariationSums>();
  for (const [variation, perVar] of keys) {
    let visitors = 0;
    for (const [k, v] of visitorsByDate) if (k.startsWith(`${variation}|`)) visitors += v;
    out.set(variation, { visitors, keys: perVar });
  }
  return out;
}

const div = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** §2.3 derived metrics for one variation (null where the denominator is 0). */
export function deriveMetrics(v: VariationSums): Record<string, number | null> {
  const k = (key: string): Summed => v.keys.get(key) ?? ZERO;
  const n = v.visitors;
  const purchase = k('purchase');
  const step = (later: string, earlier: string): number | null =>
    div(k(later).converted, k(earlier).converted);
  const oneMinus = (x: number | null): number | null => (x === null ? null : 1 - x);
  return {
    visitors: n,
    purchasers: purchase.converted,
    orders: purchase.count,
    revenue: k('revenue').sum,
    cr: div(purchase.converted, n),
    aov: div(purchase.sum, purchase.count),
    rpv: div(k('revenue').sum, n),
    arpu: div(k('revenue').sum, n),
    add_to_cart_rate: div(k('add_to_cart').converted, n),
    begin_checkout_rate: div(k('begin_checkout').converted, n),
    lead_rate: div(k('lead').converted, n),
    upsell_rate: div(k('upsell').count, purchase.count),
    upsell_rpv: div(k('upsell').sum, n),
    orders_per_purchaser: div(purchase.count, purchase.converted),
    basket_size: div(k('units').count, purchase.count),
    avg_item_price: div(k('units').sum, k('units').count),
    buy_to_cart: div(k('units_bought_from_cart').count, k('units_added').count),
    coupon_rate: div(k('coupon').count, purchase.count),
    lead_to_customer: div(k('lead_purchase').converted, k('lead').converted),
    repeat_purchase_rate: div(k('repeat_purchase').converted, purchase.converted),
    cart_abandonment: oneMinus(div(k('cart_purchase').converted, k('add_to_cart').converted)),
    checkout_abandonment: oneMinus(
      div(k('checkout_purchase').converted, k('begin_checkout').converted),
    ),
    step_cart_to_checkout: step('begin_checkout', 'add_to_cart'),
    step_payment_to_purchase: step('purchase', 'add_payment_info'),
    reached_add_to_cart: k('add_to_cart').converted,
    reached_begin_checkout: k('begin_checkout').converted,
    reached_add_shipping_info: k('add_shipping_info').converted,
    reached_add_payment_info: k('add_payment_info').converted,
    reached_purchase: purchase.converted,
    cart_purchase_converted: k('cart_purchase').converted,
    checkout_purchase_converted: k('checkout_purchase').converted,
    event_size_guide_opened: div(k('event:size_guide_opened').converted, n),
    goal_12: div(k('goal:12').converted, n),
  };
}
