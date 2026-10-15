/**
 * Daily metric keys (PRD-006 §2.3): parsing, validation, and the per-visitor
 * SQL each key reduces to. Every key is defined by four per-visitor values
 * (computed from the per-visitor aggregates in `daily-rows-sql.ts`):
 *   c  0/1 — the visitor did it at least once      → row.converted = Σ c
 *   n  count of events / orders / units / sessions → row.count     = Σ n
 *   s  money (report currency) or seconds          → row.sum       = Σ s,  sum_sq_visitor = Σ s²
 *   q  Σ value² per order / unit / session          → row.sum_sq    = Σ q
 * Semantics mirror the oracle `summary_values` in docs/reference/samples/generate.py.
 */
import {
  BUILTIN_METRIC_KEYS,
  type BuiltinMetricKey,
  DIMENSION_KEYS,
  type DimensionKey,
  type MetricKey,
} from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';

export interface KeySql {
  c: string;
  n: string;
  s: string;
  q: string;
}

const ZERO = '0';
const flag = (cond: string): string => `toUInt64(${cond})`;
const plain = (n: string): KeySql => ({ c: flag(`${n} > 0`), n, s: ZERO, q: ZERO });
const valued = (n: string, s: string, q: string): KeySql => ({ c: flag(`${n} > 0`), n, s, q });
const both = (cond: string): KeySql => ({ c: flag(cond), n: flag(cond), s: ZERO, q: ZERO });

/** Per-visitor SQL per built-in key; column names come from `daily-rows-sql.ts`. */
export const BUILTIN_KEY_SQL: Record<BuiltinMetricKey, KeySql> = {
  purchase: valued('init_n', 'init_sum', 'init_sq'),
  upsell: {
    c: flag('ups_n > 0'),
    n: 'toUInt64(arrayCount(o -> has(ups_parents, o), init_orders))',
    s: 'ups_sum',
    q: 'ups_sq',
  },
  revenue: {
    c: flag('init_n + ups_n > 0'),
    n: 'init_n + ups_n',
    s: 'init_sum + ups_sum',
    q: 'init_sq + ups_sq',
  },
  add_to_cart: valued('atc_n', 'atc_sum', 'atc_sq'),
  begin_checkout: valued('bc_n', 'bc_sum', 'bc_sq'),
  add_shipping_info: plain('asi_n'),
  add_payment_info: plain('api_n'),
  generate_lead: plain('gl_n'),
  sign_up: plain('su_n'),
  page_view: plain('pv_n'),
  units: { c: flag('init_n > 0'), n: 'units_n', s: 'units_sum', q: 'units_sq' },
  units_added: plain('added_n'),
  units_bought_from_cart: plain('b2c_n'),
  coupon: plain('coupon_n'),
  lead: plain('gl_n + su_n'),
  lead_purchase: both('gl_n + su_n > 0 AND init_n > 0'),
  repeat_purchase: both('init_n >= 2'),
  cart_purchase: both('atc_n > 0 AND init_n > 0'),
  checkout_purchase: both('bc_n > 0 AND init_n > 0'),
  session: valued('sess_n', 'sess_sum', 'sess_sq'),
};

export type ParsedKey =
  | { kind: 'builtin'; key: BuiltinMetricKey }
  | { kind: 'event'; key: MetricKey; name: string }
  | { kind: 'goal'; key: MetricKey; goalId: number };

const EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const GOAL_RE = /^goal:([1-9]\d{0,17})$/;

const isBuiltin = (k: string): k is BuiltinMetricKey =>
  (BUILTIN_METRIC_KEYS as readonly string[]).includes(k);

/** Parse one metric key; throws 400 `unknown_metric` (field = the key) when invalid. */
export function parseMetricKey(raw: unknown): ParsedKey {
  if (typeof raw !== 'string') throw new SyncApiError('unknown_metric', 400, String(raw));
  if (isBuiltin(raw)) return { kind: 'builtin', key: raw };
  if (raw.startsWith('event:')) {
    const name = raw.slice('event:'.length);
    if (EVENT_NAME_RE.test(name)) return { kind: 'event', key: raw as MetricKey, name };
  }
  const goal = GOAL_RE.exec(raw);
  if (goal?.[1] && Number.isSafeInteger(Number(goal[1]))) {
    return { kind: 'goal', key: raw as MetricKey, goalId: Number(goal[1]) };
  }
  throw new SyncApiError('unknown_metric', 400, raw);
}

/** Validate a metrics list: non-empty array of valid, distinct keys (order kept). */
export function parseMetrics(raw: unknown): ParsedKey[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SyncApiError('unknown_metric', 400, 'metrics');
  }
  const seen = new Set<string>();
  const out: ParsedKey[] = [];
  for (const item of raw) {
    const parsed = parseMetricKey(item);
    if (!seen.has(parsed.key)) {
      seen.add(parsed.key);
      out.push(parsed);
    }
  }
  return out;
}

export function parseDimension(raw: unknown): DimensionKey {
  if (typeof raw === 'string' && (DIMENSION_KEYS as readonly string[]).includes(raw)) {
    return raw as DimensionKey;
  }
  throw new SyncApiError('unknown_dimension', 400, String(raw));
}

/** `payment_type` is post-exposure (§6.3): only these keys may be split by it. */
export const PAYMENT_TYPE_KEYS: readonly MetricKey[] = ['add_payment_info', 'purchase'];
