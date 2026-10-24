/**
 * F1 expected values — LITERAL constants copied from
 * docs/prds/006-validation.md ("Fixture F1") and crobot
 * tasks/prd-analytics-v2.md §9. Never computed, never edited to make a check
 * pass. Raw daily rows are compared against the golden file
 * docs/reference/samples/f1/modeled/daily_summary.json instead.
 */

export const F1_FROM = '2026-10-01';
export const F1_TO = '2026-10-03';

/** Every key the F1 golden carries (subscribed by the platform-only contract checks). */
export const F1_METRICS = [
  'purchase',
  'upsell',
  'revenue',
  'add_to_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'generate_lead',
  'sign_up',
  'page_view',
  'units',
  'units_upsell',
  'units_added',
  'units_bought_from_cart',
  'coupon',
  'lead',
  'lead_purchase',
  'repeat_purchase',
  'cart_purchase',
  'checkout_purchase',
  'session',
  'event:size_guide_opened',
  'goal:12',
] as const;

/** "F1 expected — summed over D1–D3, per variation, experiment 1717". */
export const F1_PER_VARIATION = {
  100: {
    visitors: 3,
    purchasers: 1,
    orders: 1,
    revenue: 100.0,
    cr: 0.333333,
    aov: 100.0,
    rpv: 33.333333,
    add_to_cart_rate: 0.333333,
    begin_checkout_rate: 0.333333,
    lead_rate: 0.333333,
    upsell_rate: 0,
    event_size_guide_opened: 0.333333,
    goal_12: 0.333333,
  },
  101: {
    visitors: 3,
    purchasers: 2,
    orders: 2,
    revenue: 145.0,
    cr: 0.666667,
    aov: 62.5,
    rpv: 48.333333,
    add_to_cart_rate: 0.333333,
    begin_checkout_rate: 0,
    lead_rate: 0,
    upsell_rate: 0.5,
    event_size_guide_opened: 0,
    goal_12: 0,
  },
} as const;

export const F1_QUALITY = { multi_variation_visitors: 1, variation_mismatch_events: 1 } as const;

/** "F1 expected — daily rows (`purchase` key), D1–D3". */
export const F1_DAILY_PURCHASE = [
  { date: '2026-10-01', variation_id: 100, visitors: 1, converted: 1 },
  { date: '2026-10-01', variation_id: 101, visitors: 2, converted: 2 },
  { date: '2026-10-02', variation_id: 100, visitors: 2, converted: 0 },
  { date: '2026-10-02', variation_id: 101, visitors: 1, converted: 0 },
] as const;

/** "F1 expected — stopped subscription: `to` = D2". */
export const F1_STOPPED_TO_D2 = {
  to: '2026-10-02',
  variantPurchasers: 1,
  variantRevenue: 65.0,
  visitors: { 100: 3, 101: 3 },
};

/** "F1 expected — experiment 1802". */
export const F1_1802 = {
  variation: 200,
  visitors: 1,
  purchasers: 1,
  revenue: 60.0,
  absentVariation: 201,
} as const;

/** "F1 expected: V2 dashboard metrics (Part 6)" — values derivable from summed rows. null = 0/0. */
export const F1_DASHBOARD = {
  100: {
    reached_add_to_cart: 1,
    reached_begin_checkout: 1,
    reached_add_shipping_info: 1,
    reached_add_payment_info: 1,
    reached_purchase: 1,
    step_cart_to_checkout: 1.0,
    step_payment_to_purchase: 1.0,
    cart_purchase_converted: 1,
    checkout_purchase_converted: 1,
    cart_abandonment: 0.0,
    checkout_abandonment: 0.0,
    basket_size: 2.0,
    avg_item_price: 50.0,
    buy_to_cart: 1.0,
    coupon_rate: 0.0,
    orders_per_purchaser: 1.0,
    upsell_rpv: 0.0,
    arpu: 33.333333,
    lead_to_customer: 0.0,
    repeat_purchase_rate: 0.0,
  },
  101: {
    reached_add_to_cart: 1,
    reached_begin_checkout: 0,
    reached_add_shipping_info: 0,
    reached_add_payment_info: 1,
    reached_purchase: 2,
    step_cart_to_checkout: 0.0,
    step_payment_to_purchase: 2.0,
    cart_purchase_converted: 0,
    checkout_purchase_converted: 0,
    cart_abandonment: 1.0,
    checkout_abandonment: null,
    basket_size: 1.5,
    avg_item_price: 41.666667,
    buy_to_cart: 0.0,
    coupon_rate: 0.5,
    orders_per_purchaser: 1.0,
    upsell_rpv: 6.666667,
    arpu: 48.333333,
    lead_to_customer: null,
    repeat_purchase_rate: 0.0,
  },
} as const;

/** Summary query `dimension: payment_type`, keys add_payment_info + purchase. */
export const F1_PAYMENT_TYPE = {
  100: { value: 'card', add_payment_info: 1, purchase: 1 },
  101: { value: 'paypal', add_payment_info: 1, purchase: 1 },
} as const;

/** "F1 expected: products view". units_share per crobot §9 too (SKU-A 100% vs 50%). */
export const F1_PRODUCTS = {
  'SKU-A': {
    100: {
      units_added: 2,
      units_purchased: 2,
      revenue: 100.0,
      revenue_share: 1.0,
      units_share: 1.0,
      buy_to_cart: 1.0,
    },
    101: {
      units_added: 0,
      units_purchased: 2,
      revenue: 80.0,
      revenue_share: 0.551724,
      units_share: 0.5,
      buy_to_cart: null,
    },
  },
  'SKU-B': {
    101: {
      units_added: 0,
      units_purchased: 1,
      revenue: 45.0,
      revenue_share: 0.310345,
      units_share: 0.25,
    },
  },
  'SKU-U': {
    101: {
      units_added: 0,
      units_purchased: 1,
      revenue: 20.0,
      revenue_share: 0.137931,
      units_share: 0.25,
    },
  },
  'SKU-C': {
    101: {
      units_added: 1,
      units_purchased: 0,
      revenue: 0.0,
      revenue_share: 0.0,
      units_share: 0.0,
      buy_to_cart: 0.0,
    },
  },
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

/**
 * "F1 expected: health view (experiment 1717)". The doc says purchase events
 * control 2 / variant 3, while the golden health.json says 1 / 3 — a spec
 * conflict reported to the orchestrator; the harness asserts only what both agree on.
 */
export const F1_HEALTH = {
  purchaseStatus: 'ok',
  purchaseEventsVariant: 3,
  addToCartStatus: 'warning',
  addToCartPricePresent: 0.5,
  paymentTypePresent: 1.0,
  minParamWarnings: 1,
} as const;

/** crobot PRD §9 — what the live UI must show for F1 (and F3). */
export const CROBOT_S9 = {
  purchase: {
    100: { visitors: '3', conversions: '1', cr: '33.33%' },
    101: { visitors: '3', conversions: '2', cr: '66.67%' },
  },
  aov: { 100: '€100.00', 101: '€62.50' },
  rpv: { 100: '€33.33', 101: '€48.33' },
  upsellRate: { 100: '0%', 101: '50%' },
  cartAbandonment: { 100: '0%', 101: '100%' },
  paymentToPurchase: { 100: '100%', 101: '200%' },
  skuAUnitsShare: { 100: '100%', 101: '50%' },
  healthWarningEvent: 'add_to_cart',
  f3Label: 'Inconclusive',
} as const;
