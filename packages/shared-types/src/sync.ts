/**
 * Sync API contract between crobot and testa-platform (PRD-006 Part 3, §5.5).
 * Crobot subscribes an experiment, the platform models it into additive daily
 * rows on its own queue, crobot pulls them. Extras are async on-demand queries.
 */
import type {
  DistributionsParams,
  DistributionsResult,
  HealthResult,
  ProductsParams,
  ProductsResult,
  QualityBlock,
} from './report.ts';

/** The fixed daily metric keys (PRD-006 §2.3). Runtime list for allowlists. */
export const BUILTIN_METRIC_KEYS = [
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
  /** Units bought in upsell orders (R2); `units` stays initial orders only. */
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
] as const;

export type BuiltinMetricKey = (typeof BUILTIN_METRIC_KEYS)[number];

/** A daily metric key: a built-in key, a custom event, or a crobot goal id. */
export type MetricKey = BuiltinMetricKey | `event:${string}` | `goal:${number}`;

/**
 * Breakdown dimensions (PRD-006 §3.6), each a snapshot at first exposure.
 * `payment_type` (§6.3) is the exception: post-exposure, only valid with the
 * `add_payment_info` + `purchase` keys, rows carry `post_exposure: true`.
 */
export const DIMENSION_KEYS = [
  'channel',
  'referrer_domain',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'country',
  'region',
  'city',
  'device_type',
  'os_name',
  'browser_name',
  'screen_resolution',
  'visitor_type',
  'payment_type',
] as const;

export type DimensionKey = (typeof DIMENSION_KEYS)[number];

/** One additive row: first-exposure date (UTC) × variation × metric key (PRD-006 §2.3). */
export interface DailyRow {
  /** `YYYY-MM-DD`, the visitors' first-exposure date. */
  date: string;
  variation_id: number;
  metric_key: MetricKey;
  /** Exposed visitors on that date (same on every key's row). */
  visitors: number;
  /** Unique visitors who did it at least once. */
  converted: number;
  /** Events, unique orders or units, per key. */
  count: number;
  /** Money in the reporting currency, or seconds. */
  sum: number;
  /** Σ value² per item. */
  sum_sq: number;
  /** Σ (per-visitor total)². */
  sum_sq_visitor: number;
}

/** A daily row of an on-demand summary query with a `dimension` (top 10 + `(other)`). */
export interface DimensionRow extends DailyRow {
  dimension: DimensionKey;
  dimension_value: string;
  /** Set on post-exposure splits (`payment_type`): shown, never a verdict. */
  post_exposure?: true;
}

/** PRD-006 §3.3. */
export type SyncStatus = 'ready' | 'queued' | 'running' | 'not_ready' | 'failed';

/** PRD-006 §5.5 error codes (`{ error, field? }` body). */
export type SyncErrorCode =
  | 'unknown_metric'
  | 'unknown_dimension'
  | 'unknown_view'
  | 'invalid_range'
  | 'invalid_currency'
  | 'invalid_status'
  | 'experiment_not_found'
  | 'not_subscribed'
  | 'query_not_found'
  | 'version_mismatch'
  | 'expired'
  | 'too_many_queries'
  | 'unauthorized'
  | 'not_implemented';

export interface SyncError {
  error: SyncErrorCode;
  field?: string;
}

/** `PUT /api/v1/experiments/{id}/subscription` body (PRD-006 §3.1). */
export interface SubscriptionRequest {
  project_id: number;
  status: 'running' | 'stopped';
  /** Experiment start, `YYYY-MM-DD` UTC. */
  from: string;
  /** `null` while running; the stop date once stopped. */
  to: string | null;
  /** ISO 4217. */
  report_currency: string;
  metrics: MetricKey[];
}

export interface SubscriptionResponse {
  status: SyncStatus;
  /** ISO timestamp, `null` when no run is scheduled (stopped and final). */
  next_run_at: string | null;
}

/** Run state every sync read carries (PRD-006 §3.3–3.4). */
export interface RunEnvelope {
  status: SyncStatus;
  /** Run the rows come from; `null` until a run finished (`not_ready`). */
  run_id: string | null;
  computed_at: string | null;
  /** Newest ingested event the run saw. */
  data_through: string | null;
  next_run_at: string | null;
  /** Seconds; also sent as the `Retry-After` header. */
  retry_after: number;
}

/** Header fields of a modeled summary (the body of the `daily_summary*.json` samples). */
export interface SummaryMeta {
  experiment_id: number;
  from: string;
  to: string;
  report_currency: string;
  date_basis: 'first_exposure';
  cap_outliers: boolean;
  quality: QualityBlock;
}

/** Result of the `summary` view: plain daily rows, or rows split by one dimension. */
export type SummaryResult = SummaryMeta &
  ({ dimension: null; rows: DailyRow[] } | { dimension: DimensionKey; rows: DimensionRow[] });

/** `GET /api/v1/experiments/{id}/daily-summary[?since_run_id=]` (PRD-006 §3.4). */
export interface DailySummaryResponse extends RunEnvelope, SummaryMeta {
  dimension: null;
  /** Full range every time; `[]` when `not_ready` or `unchanged`. */
  rows: DailyRow[];
  /** `since_run_id` equals the current `run_id`: skip the upsert. */
  unchanged?: true;
}

export type ViewName = 'summary' | 'products' | 'distributions' | 'health';

/** Filters on first-exposure dimensions; values within a key are OR'ed, keys AND'ed. */
export type QueryFilters = Partial<Record<DimensionKey, string[]>>;

interface QueryRequestBase {
  project_id: number;
  /** `YYYY-MM-DD` UTC, inclusive. Span ≤ 400 days. */
  from: string;
  to: string;
  /** Defaults to the subscription's reporting currency. */
  report_currency?: string;
  filters?: QueryFilters;
  /** The sync button: ignore a cached result. Not part of `query_id`. */
  refresh?: boolean;
}

export interface SummaryParams {
  metrics: MetricKey[];
  /** One dimension; top 10 values by visitors + `(other)`. */
  dimension?: DimensionKey;
  /** p99 cap of initial-order values, pooled (PRD-006 §6.3). */
  cap_outliers?: boolean;
}

export interface SummaryQueryRequest extends QueryRequestBase, SummaryParams {
  view: 'summary';
}
export interface ProductsQueryRequest extends QueryRequestBase, ProductsParams {
  view: 'products';
}
export interface DistributionsQueryRequest extends QueryRequestBase, DistributionsParams {
  view: 'distributions';
}
export interface HealthQueryRequest extends QueryRequestBase {
  view: 'health';
}

/** `POST /api/v1/experiments/{id}/queries` body (PRD-006 §3.5). */
export type QueryRequest =
  | SummaryQueryRequest
  | ProductsQueryRequest
  | DistributionsQueryRequest
  | HealthQueryRequest;

/** `202` from `POST …/queries` (a cached result returns a ready `QueryResponse` with `200`). */
export interface QueryAccepted {
  /** sha256 of the canonical body minus `refresh`. */
  query_id: string;
  status: SyncStatus;
  retry_after: number;
}

interface QueryResponseBase {
  query_id: string;
  status: SyncStatus;
  retry_after: number;
  computed_at: string | null;
}

export interface SummaryQueryResponse extends QueryResponseBase {
  view: 'summary';
  /** `[]` until `ready`. */
  rows: DailyRow[] | DimensionRow[];
  dimension: DimensionKey | null;
  cap_outliers: boolean;
  quality: QualityBlock | null;
}
export interface ProductsQueryResponse extends QueryResponseBase {
  view: 'products';
  /** `null` until `ready`. */
  result: ProductsResult | null;
}
export interface DistributionsQueryResponse extends QueryResponseBase {
  view: 'distributions';
  result: DistributionsResult | null;
}
export interface HealthQueryResponse extends QueryResponseBase {
  view: 'health';
  result: HealthResult | null;
}

/** `GET /api/v1/experiments/{id}/queries/{query_id}`: `rows` for summary, `result` otherwise. */
export type QueryResponse =
  | SummaryQueryResponse
  | ProductsQueryResponse
  | DistributionsQueryResponse
  | HealthQueryResponse;

/**
 * Body of the optional webhooks (PRD-006 §3.2), POSTed to
 * `{CROBOT_WEBHOOK_URL}/api/webhooks/analytics/{event}` with
 * `X-Testa-Timestamp` + `X-Testa-Signature: sha256=<hmac>`.
 */
export type WebhookPayload =
  | {
      event: 'summary-ready';
      experiment_id: number;
      run_id: string;
      computed_at: string;
      data_through: string;
    }
  | {
      event: 'query-ready';
      experiment_id: number;
      query_id: string;
      computed_at: string;
    };
