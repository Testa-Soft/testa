/**
 * ClickHouse reads for the `distributions` view (PRD-006 §6.5, task 5.16):
 * attributed `add_payment_info` events and initial orders (purchases deduped,
 * '' purchase_type read as initial, exposure variation), with the order value
 * converted at the previous day's FX rate (`withFx`). One row per event; the
 * view folds them in TS. `order` is the oracle's walk order
 * `[first_exposed_at ms, client_ts ms]` (ties in counts keep first-seen order).
 */
import {
  type AttributionScope,
  type QueryRunner,
  buildAttributedEvents,
} from '../analytics/attribution.ts';
import { withFx } from '../fx/sql.ts';
import { buildCapQuery } from '../modeler/daily-rows-sql.ts';

export interface DistributionEvent {
  variation_id: number;
  visitor_id: string;
  kind: 'payment' | 'order';
  payment_type: string;
  coupon: string;
  currency: string;
  /** Order value in report currency (0 for payment events). */
  value: number;
  order: [number, number];
}

export interface DistributionsScope extends AttributionScope {
  reportCurrency: string;
}

export async function fetchDistributionEvents(
  query: QueryRunner,
  scope: DistributionsScope,
): Promise<DistributionEvent[]> {
  const attributed = buildAttributedEvents({
    ...scope,
    eventNames: ['add_payment_info', 'purchase'],
  });
  const rows = await query<Record<string, unknown>>(
    `SELECT
      toUInt32(w.variation_id) AS variation_id,
      w.visitor_id AS visitor_id,
      if(w.event_name = 'add_payment_info', 'payment', 'order') AS kind,
      w.props['payment_type'] AS payment_type,
      w.props['coupon'] AS coupon,
      w.currency AS currency,
      toFloat64(w.value_native) * w.fx AS value,
      toUnixTimestamp64Milli(w.first_exposed_at) AS seen_at,
      toUnixTimestamp64Milli(w.client_ts) AS ts
    FROM (${withFx(attributed.sql)}) AS w
    WHERE w.event_name = 'add_payment_info' OR w.purchase_type = 'initial'`,
    { ...attributed.params, report_currency: scope.reportCurrency },
  );
  return rows.map((r) => ({
    variation_id: Number(r.variation_id),
    visitor_id: String(r.visitor_id),
    kind: r.kind === 'payment' ? 'payment' : 'order',
    payment_type: String(r.payment_type ?? ''),
    coupon: String(r.coupon ?? ''),
    currency: String(r.currency ?? ''),
    value: Number(r.value),
    order: [Number(r.seen_at), Number(r.ts)],
  }));
}

/** p99 of initial-order values, pooled (§5.1); the modeler's own cap query. */
export async function fetchOrderCap(
  query: QueryRunner,
  scope: DistributionsScope,
): Promise<number | undefined> {
  const q = buildCapQuery(scope);
  const [row] = await query<{ cap: number; orders: string | number }>(q.sql, q.params);
  return row && Number(row.orders) > 0 ? Number(row.cap) : undefined;
}
