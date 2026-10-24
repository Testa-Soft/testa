/**
 * Fixture F1 (006-validation.md "Fixture F1 — hand-computed"). The events are
 * X0's wire encoding of the golden raw rows (`loadF1WireEvents`), moved to the
 * harness project id. Every expected value below is a LITERAL copied from the
 * doc, never computed (task 5.14: hand values catch errors an oracle could
 * share). D1 = 2026-10-01, D2 = 2026-10-02, D3 = 2026-10-03.
 */

import { type WireEvent, loadF1WireEvents } from '../../cross/shared/f1-wire.ts';
import { FIXTURES, REPO_ROOT } from '../config.ts';

export const F1 = FIXTURES.F1;
export const F1_FROM = '2026-10-01';
export const F1_TO = '2026-10-03';
export const F1_D2 = '2026-10-02';

export function f1WireEvents(): { events: WireEvent[]; itemRows: number } {
  const { events, itemRows } = loadF1WireEvents(REPO_ROOT);
  return { events: events.map((e) => ({ ...e, project_id: F1.projectId })), itemRows };
}

type PerVariation<T> = { readonly 100: T; readonly 101: T };

/** "F1 expected — summed over D1–D3, per variation, experiment 1717". */
export const F1_SUMMED: Readonly<Record<string, PerVariation<number>>> = {
  visitors: { 100: 3, 101: 3 },
  purchasers: { 100: 1, 101: 2 },
  orders: { 100: 1, 101: 2 },
  revenue: { 100: 100.0, 101: 145.0 },
  cr: { 100: 0.333333, 101: 0.666667 },
  aov: { 100: 100.0, 101: 62.5 },
  rpv: { 100: 33.333333, 101: 48.333333 },
  add_to_cart_rate: { 100: 0.333333, 101: 0.333333 },
  begin_checkout_rate: { 100: 0.333333, 101: 0 },
  lead_rate: { 100: 0.333333, 101: 0 },
  upsell_rate: { 100: 0, 101: 0.5 },
  'event:size_guide_opened': { 100: 0.333333, 101: 0 },
  'goal:12': { 100: 0.333333, 101: 0 },
};

export const F1_QUALITY = { multi_variation_visitors: 1, variation_mismatch_events: 1 } as const;

/** "F1 expected — daily rows (`purchase` key), D1–D3". */
export const F1_DAILY_PURCHASE = [
  { date: '2026-10-01', variation_id: 100, visitors: 1, converted: 1 },
  { date: '2026-10-01', variation_id: 101, visitors: 2, converted: 2 },
  { date: '2026-10-02', variation_id: 100, visitors: 2, converted: 0 },
  { date: '2026-10-02', variation_id: 101, visitors: 1, converted: 0 },
] as const;

/** "stopped subscription: `to` = D2": variant purchasers 1, revenue 65.00, visitors 3 / 3. */
export const F1_STOPPED_D2 = {
  purchasers: { 100: 1, 101: 1 },
  revenue101: 65.0,
  visitors: { 100: 3, 101: 3 },
} as const;

/** "experiment 1802": variation 200 visitors 1, purchasers 1, revenue 60.00; 201 has no rows. */
export const F1_EXP_1802 = { variation: 200, visitors: 1, purchasers: 1, revenue: 60.0 } as const;

/** "V2 dashboard metrics (Part 6)"; `null` where the doc says null. */
export const F1_DASHBOARD: Readonly<Record<string, PerVariation<number | null>>> = {
  'reached:add_to_cart': { 100: 1, 101: 1 },
  'reached:begin_checkout': { 100: 1, 101: 0 },
  'reached:add_shipping_info': { 100: 1, 101: 0 },
  'reached:add_payment_info': { 100: 1, 101: 1 },
  'reached:purchase': { 100: 1, 101: 2 },
  step_cart_to_checkout: { 100: 1.0, 101: 0.0 },
  step_payment_to_purchase: { 100: 1.0, 101: 2.0 },
  cart_purchase: { 100: 1, 101: 0 },
  checkout_purchase: { 100: 1, 101: 0 },
  cart_abandonment: { 100: 0.0, 101: 1.0 },
  checkout_abandonment: { 100: 0.0, 101: null },
  basket_size: { 100: 2.0, 101: 1.5 },
  avg_item_price: { 100: 50.0, 101: 41.666667 },
  units_sold: { 100: 2, 101: 4 },
  buy_to_cart: { 100: 1.0, 101: 0.0 },
  coupon_rate: { 100: 0.0, 101: 0.5 },
  orders_per_purchaser: { 100: 1.0, 101: 1.0 },
  upsell_rpv: { 100: 0.0, 101: 6.666667 },
  arpu: { 100: 33.333333, 101: 48.333333 },
  lead_to_customer: { 100: 0.0, 101: null },
  repeat_purchase_rate: { 100: 0.0, 101: 0.0 },
};

/** Summary with `dimension: payment_type`, keys add_payment_info + purchase. */
export const F1_PAYMENT_TYPE = {
  100: { value: 'card', add_payment_info: 1, purchase: 1 },
  101: { value: 'paypal', add_payment_info: 1, purchase: 1 },
} as const;

/** "F1 expected: products view": added / purchased / revenue / share per variation. */
export const F1_PRODUCTS = {
  'SKU-A': { 100: [2, 2, 100.0, 1.0], 101: [0, 2, 80.0, 0.551724] },
  'SKU-B': { 101: [0, 1, 45.0, 0.310345] },
  'SKU-U': { 101: [0, 1, 20.0, 0.137931] },
  'SKU-C': { 101: [1, 0, 0.0, 0.0] },
} as const;
export const F1_BUY_TO_CART = { 'SKU-A': { 100: 1.0, 101: null }, 'SKU-C': { 101: 0.0 } } as const;
export const F1_UNITS_SHARE = {
  100: { 'SKU-A': 1.0 },
  101: { 'SKU-A': 0.5, 'SKU-B': 0.25, 'SKU-U': 0.25, 'SKU-C': 0.0 },
} as const;

/** "F1 expected: distributions view". */
export const F1_DISTRIBUTIONS = {
  payment_type: { 100: [['card', 1, 1.0]], 101: [['paypal', 1, 1.0]] },
  coupon: {
    100: [['No coupon', 1, 1.0]],
    101: [
      ['WELCOME10', 1, 0.5],
      ['No coupon', 1, 0.5],
    ],
  },
  currency: {
    100: [['EUR', 1, 1.0]],
    101: [
      ['USD', 1, 0.5],
      ['EUR', 1, 0.5],
    ],
  },
} as const;

/** "F1 expected: health view (experiment 1717)". */
export const F1_HEALTH = {
  purchase_events: { 100: 2, 101: 3 },
  purchase_status: 'ok',
  add_to_cart_price_present: 0.5,
  add_to_cart_status: 'warning',
  payment_type_present: 1.0,
  min_param_warnings: 1,
} as const;
