/**
 * Query-view params/results (products, distributions, health; PRD-006 §6.5),
 * the data-quality block, and the stateless stats endpoint (PRD-006 §4.5).
 * Reference shapes: `docs/reference/samples/{demo,f1}/modeled/*.json`.
 */

/** Keyed by platform variation id as a string (`"100"`), as JSON objects require. */
export type ByVariation<T> = Record<string, T>;

/** PRD-006 §2.1 / §2.5. */
export interface QualityBlock {
  /** Visitors seen in >1 variation of the experiment; excluded from every row. */
  multi_variation_visitors: number;
  /** Events whose stamped variation disagrees with the exposure variation. */
  variation_mismatch_events: number;
  /**
   * Attributed orders in a currency with no known rate: left out of every
   * money `sum` (PRD-006 §5.1, task 5.19). Present only when > 0.
   */
  unconvertible_orders?: number;
}

// ─── products ───────────────────────────────────────────────────────────────

export type ProductsPurchaseType = 'all' | 'initial' | 'upsell';
export type ProductsSort = 'control_revenue' | 'revenue_share';

export interface ProductsParams {
  /** Set → detail mode (variants of that product). */
  product_id?: string;
  purchase_type?: ProductsPurchaseType;
  search?: string;
  /** Default `control_revenue`. */
  sort?: ProductsSort;
  /** Default 8; everything beyond is folded into one "Other products" row. */
  limit?: number;
  offset?: number;
}

export interface ProductVariationValues {
  units_added: number;
  units_purchased: number;
  /** Units ÷ all units in that variation; `null` when the variation bought nothing. */
  units_share: number | null;
  /** Σ min(bought, carted) per visitor × product ÷ units added; `null` with nothing added. */
  buy_to_cart: number | null;
  revenue: number;
  revenue_share: number | null;
}

export interface ProductVariantValues {
  units: number;
  /** Variant popularity within the product. */
  share_of_product: number | null;
  revenue_share: number | null;
}

export interface ProductVariant {
  /** `item_variant`, falling back to `item_id`. */
  item_variant: string;
  by_variation: ByVariation<ProductVariantValues>;
  /** Control units < 15. */
  low_sample: boolean;
}

export interface ProductRow {
  /** `(other)` on the folded "Other products" row. */
  product_id: string;
  name: string;
  /** `null` on the "Other products" row. */
  unit_price: number | null;
  by_variation: ByVariation<ProductVariationValues>;
  /** Top 10 + Other; `[]` on the "Other products" row. */
  variants: ProductVariant[];
  /** Only on the "Other products" row: how many products it folds. */
  product_count?: number;
}

interface ProductsResultBase {
  experiment_id: number;
  from: string;
  to: string;
  report_currency: string;
  purchase_type: ProductsPurchaseType;
}

/** List mode (no `product_id`). */
export interface ProductsListResult extends ProductsResultBase {
  sort: ProductsSort;
  limit: number;
  offset: number;
  total_products: number;
  products: ProductRow[];
}

export interface ProductDetailVariant {
  item_variant: string;
  item_id: string;
  share: ByVariation<number | null>;
  units: ByVariation<number>;
}

/** Detail mode (`product_id` set; PRD-006 §6.5). */
export interface ProductDetailResult extends ProductsResultBase {
  product_id: string;
  variants: ProductDetailVariant[];
  kpis: {
    units_purchased: ByVariation<number>;
    buy_to_cart: ByVariation<number | null>;
    revenue_share: ByVariation<number | null>;
  };
}

export type ProductsResult = ProductsListResult | ProductDetailResult;

// ─── distributions ──────────────────────────────────────────────────────────

export type DistributionKey = 'payment_type' | 'coupon' | 'currency' | 'order_value';

export interface DistributionsParams {
  /** Default: all four. */
  distributions?: DistributionKey[];
  /** Custom bin lower bounds in report currency; default 8 pooled quantile bins. */
  order_value_bins?: number[];
  cap_outliers?: boolean;
}

export interface CategoryBucket {
  value: string;
  count: number;
  share: number;
}

export interface CategoricalDistribution {
  basis: 'add_payment_info events' | 'initial orders';
  by_variation: ByVariation<CategoryBucket[]>;
}

export interface HistogramBucket {
  from: number;
  /** `null` on the open last bin. */
  to: number | null;
  count: number;
  /** `null` when the variation has no orders. */
  share: number | null;
}

export interface HistogramDistribution {
  basis: 'initial orders';
  bins: number[];
  by_variation: ByVariation<HistogramBucket[]>;
}

/** Outlier capping applied to initial orders (R4; PRD-006 §6.3). */
export interface CappedOrders {
  /** Pooled p99 of initial-order values, report currency (0 when there are no orders). */
  threshold: number;
  /** Initial orders whose value exceeded the threshold, per variation. */
  by_variation: ByVariation<number>;
}

export interface DistributionsResult {
  experiment_id: number;
  from: string;
  to: string;
  report_currency: string;
  /** Only the requested distributions are present. */
  distributions: {
    payment_type?: CategoricalDistribution;
    coupon?: CategoricalDistribution;
    currency?: CategoricalDistribution;
    order_value?: HistogramDistribution;
  };
  /** Present only when the query set `cap_outliers: true` (R4). */
  capped?: CappedOrders;
}

// ─── health ─────────────────────────────────────────────────────────────────

/**
 * Required parameters per event for the health view (PRD-006 §6.5). Order is
 * the order the health view reports them in.
 */
export const EVENT_PARAM_SPEC = {
  purchase: [
    'order_id',
    'value_native',
    'currency',
    'items',
    'items[].item_id',
    'items[].price',
    'items[].quantity',
    'purchase_type',
  ],
  add_to_cart: ['items', 'items[].item_id', 'items[].price'],
  add_payment_info: ['payment_type'],
  begin_checkout: [],
  add_shipping_info: [],
  experiment_view: [],
  page_view: [],
} as const satisfies Record<string, readonly string[]>;

export type HealthEventName = keyof typeof EVENT_PARAM_SPEC;

export interface HealthParamCoverage {
  param: string;
  required: boolean;
  /** 0..1; `null` when the event never fired. */
  present_pct: number | null;
}

export interface HealthEvent {
  event_name: string;
  /** `missing` = no events in the window; `warning` = a required param < 95% present. */
  status: 'ok' | 'warning' | 'missing';
  last_event_at: string | null;
  events: ByVariation<number>;
  visitors: ByVariation<number>;
  params: HealthParamCoverage[];
}

export interface HealthMetric {
  key: string;
  availability: 'full' | 'limited' | 'unavailable';
  /** Empty when `full`. */
  reason: string;
}

export interface SrmResult {
  chi2: number;
  p_value: number;
  /** `p_value ≥ 0.001`. */
  ok: boolean;
  expected_weights: ByVariation<number>;
}

export interface HealthResult {
  experiment_id: number;
  from: string;
  to: string;
  events: HealthEvent[];
  metrics: HealthMetric[];
  srm: SrmResult;
  summary: {
    events_receiving: number;
    events_expected: number;
    param_warnings: number;
    metrics_full: number;
    metrics_limited: number;
  };
}

// ─── stats (POST /api/v1/stats) ─────────────────────────────────────────────

/**
 * `beta`: a rate (n, x). `normal`: a mean (n, sum, sumSq). `count`: mean
 * events per visitor for `count_mode: every` goals — n = visitors,
 * sum = Σ count, sumSq = Σ count_sq_visitor (admin v2).
 */
export type StatModel = 'beta' | 'normal' | 'count';

/** Summed inputs for one variation of one metric. */
export interface StatsVariationInput {
  variation: number;
  /** Denominator: visitors, orders, units… */
  n: number;
  /** Successes (beta). */
  x?: number;
  /** Normal: Σx and Σx². Count: Σ count and Σ count_sq_visitor. */
  sum?: number;
  sumSq?: number;
}

export interface StatsMetricInput {
  key: string;
  model: StatModel;
  /** Default `higher`; `lower` flips chance to beat control (e.g. abandonment). */
  direction?: 'higher' | 'lower';
  variations: StatsVariationInput[];
}

/** `POST /api/v1/stats` body (PRD-006 §4.5, task 5.11). Max 50 metrics × 10 variations. */
export interface StatsRequest {
  /** Control variation id. */
  control: number;
  /** Default 0.95. */
  confidence?: number;
  /** Override the draw count (default 100k, 10k with `segment`). */
  draws?: number;
  /** Segment rows: 10k draws, never a winner. */
  segment?: boolean;
  metrics: StatsMetricInput[];
}

/** PRD-006 §4.3. Control carries `chance_to_be_best` only. */
export interface VariationStats {
  chance_to_beat_control?: number;
  chance_to_be_best: number;
  lift?: number;
  lift_ci?: [number, number];
  expected_loss?: number;
  insufficient_data?: true;
}

export interface StatsResponse {
  /** metric key → variation id → stats. */
  metrics: Record<string, ByVariation<VariationStats>>;
}
