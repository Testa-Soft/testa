/**
 * The daily-rows query (PRD-006 §2.4): exposed set ⟕ per-visitor aggregates,
 * grouped by first-exposure date × variation × raw dimension value. Returns
 * one WIDE row per group (`visitors` + 5 columns per key); `daily-rows.ts`
 * folds dimension values into top 10 + `(other)` and pivots into rows.
 *
 * Per-visitor layers, all over the shared attributed-events select (5.18):
 *   V  events  → order / step / custom-event / goal counts, money (FX'd, capped)
 *   S  sessions → per experiment session: max(client_ts) − session_start (§5.4)
 *   I  items    → units bought (initial / upsell) / added, buy-to-cart (min per visitor × product)
 */
import type { DimensionKey } from '@testa-platform/shared-types';
import {
  type AttributionScope,
  type SqlQuery,
  buildAttributedEvents,
  buildExposedVisitors,
  dimColumn,
} from '../analytics/attribution.ts';
import { withFx } from '../fx/sql.ts';
import { BUILTIN_KEY_SQL, type KeySql, type ParsedKey } from './metric-keys.ts';

export interface DailyRowsQueryParams extends AttributionScope {
  reportCurrency: string;
  keys: readonly ParsedKey[];
  dimension?: DimensionKey;
  /** p99 cap for initial-order values (report currency), when capping. */
  cap?: number;
}

/** Wide-row column for key #i and field f (c, n, s, q, v). */
export const keyColumn = (i: number, f: 'c' | 'n' | 's' | 'q' | 'v'): string => `k${i}_${f}`;

const IS_INIT = `(event_name = 'purchase' AND purchase_type = 'initial')`;
const IS_UPS = `(event_name = 'purchase' AND purchase_type = 'upsell')`;

function keySql(key: ParsedKey, i: number): KeySql {
  if (key.kind === 'builtin') return BUILTIN_KEY_SQL[key.key];
  const n = key.kind === 'event' ? `cev_${i}` : `cgoal_${i}`;
  return { c: `toUInt64(${n} > 0)`, n, s: '0', q: '0' };
}

function customCounters(keys: readonly ParsedKey[]): {
  sql: string;
  params: Record<string, unknown>;
} {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  keys.forEach((key, i) => {
    if (key.kind === 'event') {
      parts.push(`countIf(event_name = {ev_${i}:String}) AS cev_${i}`);
      params[`ev_${i}`] = key.name;
    } else if (key.kind === 'goal') {
      parts.push(
        `countIf(event_name = 'conversion' AND goal_id = {goal_${i}:UInt64}) AS cgoal_${i}`,
      );
      params[`goal_${i}`] = key.goalId;
    }
  });
  return { sql: parts.map((p) => `,\n        ${p}`).join(''), params };
}

/** Attributed events of every name, with `fx`, `m` (converted value) and order flags. */
function moneyEvents(attributedSql: string, cap: number | undefined): string {
  const mInit = cap === undefined ? 'm' : 'least(m, {cap:Float64})';
  return `
      SELECT f.*, ${mInit} AS m_init
      FROM (
        SELECT w.*, toFloat64(w.value_native) * w.fx AS m
        FROM (${withFx(attributedSql)}) AS w
      ) AS f`;
}

function visitorEvents(money: string, custom: string): string {
  return `
    SELECT
        visitor_id,
        countIf(${IS_INIT}) AS init_n,
        sumIf(m_init, ${IS_INIT}) AS init_sum,
        sumIf(m_init * m_init, ${IS_INIT}) AS init_sq,
        groupArrayIf(order_id, ${IS_INIT}) AS init_orders,
        countIf(${IS_UPS}) AS ups_n,
        sumIf(m, ${IS_UPS}) AS ups_sum,
        sumIf(m * m, ${IS_UPS}) AS ups_sq,
        groupUniqArrayIf(parent_order_id, ${IS_UPS}) AS ups_parents,
        countIf(event_name = 'add_to_cart') AS atc_n,
        sumIf(m, event_name = 'add_to_cart') AS atc_sum,
        sumIf(m * m, event_name = 'add_to_cart') AS atc_sq,
        countIf(event_name = 'begin_checkout') AS bc_n,
        sumIf(m, event_name = 'begin_checkout') AS bc_sum,
        sumIf(m * m, event_name = 'begin_checkout') AS bc_sq,
        countIf(event_name = 'add_shipping_info') AS asi_n,
        countIf(event_name = 'add_payment_info') AS api_n,
        countIf(event_name = 'generate_lead') AS gl_n,
        countIf(event_name = 'sign_up') AS su_n,
        countIf(event_name = 'page_view') AS pv_n,
        countIf(${IS_INIT} AND props['coupon'] != '') AS coupon_n,
        argMaxIf(props['payment_type'], client_ts, event_name = 'add_payment_info') AS pay_type${custom}
    FROM (${money}) AS me
    GROUP BY visitor_id`;
}

function visitorSessions(attributedSql: string): string {
  return `
    SELECT visitor_id, count() AS sess_n, sum(secs) AS sess_sum, sum(secs * secs) AS sess_sq
    FROM (
      SELECT visitor_id, session_start,
             toUnixTimestamp64Milli(max(client_ts)) / 1000 - session_start AS secs
      FROM (${attributedSql}) AS sa
      GROUP BY visitor_id, session_start
    )
    GROUP BY visitor_id`;
}

function visitorItems(money: string): string {
  return `
    SELECT visitor_id,
           sum(u_n) AS units_n, sum(u_sum) AS units_sum, sum(u_sq) AS units_sq,
           sum(uu_n) AS ups_units_n, sum(uu_sum) AS ups_units_sum, sum(uu_sq) AS ups_units_sq,
           sum(carted) AS added_n, sum(least(bought, carted)) AS b2c_n
    FROM (
      SELECT a.visitor_id AS visitor_id, it.product_id AS product_id,
             sumIf(it.quantity, a.is_init) AS u_n,
             sumIf(toFloat64(it.price) * a.fx * it.quantity, a.is_init) AS u_sum,
             sumIf(pow(toFloat64(it.price) * a.fx, 2) * it.quantity, a.is_init) AS u_sq,
             sumIf(it.quantity, a.is_ups) AS uu_n,
             sumIf(toFloat64(it.price) * a.fx * it.quantity, a.is_ups) AS uu_sum,
             sumIf(pow(toFloat64(it.price) * a.fx, 2) * it.quantity, a.is_ups) AS uu_sq,
             sumIf(it.quantity, a.event_name = 'purchase') AS bought,
             sumIf(it.quantity, a.event_name = 'add_to_cart') AS carted
      FROM (
        SELECT event_id, visitor_id, event_name, fx, ${IS_INIT} AS is_init, ${IS_UPS} AS is_ups
        FROM (${money}) AS mi
        WHERE event_name IN ('purchase', 'add_to_cart')
      ) AS a
      INNER JOIN (
        SELECT event_id, product_id, quantity, price
        FROM event_items
        WHERE project_id = {project_id:UInt64} AND has(exp_ids, {experiment_id:UInt64})
      ) AS it ON it.event_id = a.event_id
      GROUP BY a.visitor_id, it.product_id
    )
    GROUP BY visitor_id`;
}

function dimensionValue(dimension: DimensionKey | undefined): string {
  if (dimension === undefined) return `''`;
  const raw = dimension === 'payment_type' ? 'v.pay_type' : `x.${dimColumn(dimension)}`;
  return `if(${raw} = '', '(none)', ${raw})`;
}

/** The wide grouped query. Columns: date, variation_id, dv, dv_first, visitors, k<i>_<f>. */
export function buildDailyRowsQuery(p: DailyRowsQueryParams): SqlQuery {
  const exposureDims = p.dimension && p.dimension !== 'payment_type' ? [p.dimension] : [];
  const exposed = buildExposedVisitors({ ...p, dims: exposureDims });
  const attributed = buildAttributedEvents({ ...p, dims: [] });
  const custom = customCounters(p.keys);
  const money = moneyEvents(attributed.sql, p.cap);

  const keyCols = p.keys.flatMap((key, i) => {
    const k = keySql(key, i);
    return [
      `sum(${k.c}) AS ${keyColumn(i, 'c')}`,
      `sum(${k.n}) AS ${keyColumn(i, 'n')}`,
      `sum(${k.s}) AS ${keyColumn(i, 's')}`,
      `sum(${k.q}) AS ${keyColumn(i, 'q')}`,
      `sum(pow(${k.s}, 2)) AS ${keyColumn(i, 'v')}`,
    ];
  });

  const sql = `
SELECT
    x.date AS date,
    x.variation_id AS variation_id,
    ${dimensionValue(p.dimension)} AS dv,
    toString(min(x.first_exposed_at)) AS dv_first,
    count() AS visitors,
    ${keyCols.join(',\n    ')}
FROM (${exposed.sql}) AS x
LEFT JOIN (${visitorEvents(money, custom.sql)}) AS v ON v.visitor_id = x.visitor_id
LEFT JOIN (${visitorSessions(attributed.sql)}) AS s ON s.visitor_id = x.visitor_id
LEFT JOIN (${visitorItems(money)}) AS it ON it.visitor_id = x.visitor_id
GROUP BY date, variation_id, dv
ORDER BY date, variation_id, dv`;

  return {
    sql,
    params: {
      ...exposed.params,
      ...attributed.params,
      ...custom.params,
      report_currency: p.reportCurrency,
      ...(p.cap === undefined ? {} : { cap: p.cap }),
    },
  };
}

/** p99 of initial-order values in the report currency, pooled over all variations. */
export function buildCapQuery(p: AttributionScope & { reportCurrency: string }): SqlQuery {
  const attributed = buildAttributedEvents({ ...p, eventNames: ['purchase'] });
  return {
    sql: `
SELECT quantileExactInclusive(0.99)(m) AS cap, count() AS orders
FROM (${moneyEvents(attributed.sql, undefined)}) AS c
WHERE purchase_type = 'initial'`,
    params: { ...attributed.params, report_currency: p.reportCurrency },
  };
}

/** Attributed orders whose currency has no usable rate (left out of money sums). */
export function buildUnconvertibleQuery(
  p: AttributionScope & { reportCurrency: string },
): SqlQuery {
  const attributed = buildAttributedEvents({ ...p, eventNames: ['purchase'] });
  return {
    sql: `
SELECT sum(fx_unconvertible) AS n
FROM (${withFx(attributed.sql)}) AS u`,
    params: { ...attributed.params, report_currency: p.reportCurrency },
  };
}
