/**
 * generate.py `summary_values` + `daily_summary` (v2 daily-summary contract).
 */

import type { RawEvent } from '../raw.ts';
import type { Model } from './model.ts';
import { expIndex, fx, itemsOf } from './model.ts';
import { parseTs, pyRound, pyStr, pySum, pyTruthy } from './pymath.ts';

export const SUMMARY_KEYS = [
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

const EVENT_PREFIX = 'event:';
const GOAL_PREFIX = 'goal:';

/** (converted 0/1, count, sum, per-unit values for sum_sq). */
type SummaryTuple = readonly [number, number, number, readonly number[]];

export interface DailySummaryRow {
  readonly date: string;
  readonly variation_id: number;
  readonly dimension?: string;
  readonly dimension_value?: unknown;
  readonly metric_key: string;
  readonly visitors: number;
  readonly converted: number;
  readonly count: number;
  readonly sum: number;
  readonly sum_sq: number;
  readonly sum_sq_visitor: number;
}

export interface DailySummary {
  readonly experiment_id: number;
  readonly from: string;
  readonly to: string;
  readonly report_currency: string;
  readonly date_basis: 'first_exposure';
  readonly cap_outliers: boolean;
  readonly dimension: string | null;
  readonly quality: {
    readonly multi_variation_visitors: number;
    readonly variation_mismatch_events: number;
  };
  readonly rows: readonly DailySummaryRow[];
}

export interface DailySummaryOptions {
  readonly keys?: readonly string[];
  readonly dimension?: string;
  readonly capped?: boolean;
}

function groupByName(es: readonly RawEvent[]): (name: string) => readonly RawEvent[] {
  const by = new Map<string, RawEvent[]>();
  for (const e of es) {
    const list = by.get(e.event_name) ?? [];
    list.push(e);
    by.set(e.event_name, list);
  }
  return (name) => by.get(name) ?? [];
}

function addTo(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

function cartCounts(m: Model, by: (name: string) => readonly RawEvent[]) {
  const carted = new Map<string, number>();
  const bought = new Map<string, number>();
  for (const e of by('add_to_cart')) {
    for (const it of itemsOf(m, e)) addTo(carted, it.product_id, it.quantity);
  }
  for (const e of by('purchase')) {
    for (const it of itemsOf(m, e)) addTo(bought, it.product_id, it.quantity);
  }
  const fromCart = [...carted].map(([p, c]) => Math.min(bought.get(p) ?? 0, c));
  return { carted, fromCart };
}

function sessionSecs(m: Model, es: readonly RawEvent[]): number[] {
  const sess = new Map<number, number>();
  for (const e of es) {
    const s0 = e.exp_session_starts[expIndex(e, m.expId)];
    if (s0 === undefined) throw new Error(`oracle: event ${e.event_id} lacks session start`);
    const prev = sess.get(s0) ?? 0;
    const cur = parseTs(e.client_ts) - s0;
    sess.set(s0, cur > prev ? cur : prev);
  }
  return [...sess.values()];
}

/** One value per unit bought (price × FX, missing price = 0). */
function unitValues(m: Model, orders: readonly RawEvent[]): number[] {
  const out: number[] = [];
  for (const e of orders) {
    for (const it of itemsOf(m, e)) {
      for (let q = 0; q < it.quantity; q++) out.push((it.price ?? 0) * fx(e.currency));
    }
  }
  return out;
}

function flag(b: boolean): number {
  return b ? 1 : 0;
}

/**
 * Per visitor, per metric key (generate.py `summary_values`). Returns a lookup;
 * any `event:<name>` / `goal:<id>` key is supported, not only the two hardcoded ones.
 */
export function summaryValues(
  m: Model,
  vid: string,
  capped = false,
): (key: string) => SummaryTuple {
  const es = m.att.get(vid) ?? [];
  const by = groupByName(es);
  const money = (e: RawEvent): number => {
    const v = e.value_native * fx(e.currency);
    return capped && (e.purchase_type === 'initial' || e.purchase_type === '')
      ? Math.min(v, m.cap)
      : v;
  };
  const init = by('purchase').filter(
    (e) => e.purchase_type === 'initial' || e.purchase_type === '',
  );
  const ups = by('purchase').filter((e) => e.purchase_type === 'upsell');
  const upsold = new Set(ups.map((e) => e.parent_order_id));
  const leadCount = by('generate_lead').length + by('sign_up').length;
  const lead = leadCount > 0;
  const { carted, fromCart } = cartCounts(m, by);
  const sess = sessionSecs(m, es);
  const unitVals = unitValues(m, init);
  // R2: units bought in upsell orders (`units` keeps its meaning: initial orders only).
  const upsUnitVals = unitValues(m, ups);
  const ev = (name: string, vals?: readonly number[]): SummaryTuple => {
    const lst = by(name);
    const v = vals ?? lst.map((e) => (pyTruthy(e.currency) ? e.value_native * fx(e.currency) : 0));
    return [flag(lst.length > 0), lst.length, pySum(v), v];
  };
  const both = (a: boolean, b: boolean): SummaryTuple => [flag(a && b), flag(a && b), 0.0, []];
  const initVals = init.map(money);
  const upsVals = ups.map(money);
  const revVals = [...init, ...ups].map(money);
  const couponOrders = init.filter((e) => pyTruthy(e.props.coupon)).length;
  const hasInit = init.length > 0;
  const fixed = new Map<string, SummaryTuple>([
    ['purchase', [flag(hasInit), init.length, pySum(initVals), initVals]],
    [
      'upsell',
      [
        flag(ups.length > 0),
        init.filter((e) => upsold.has(e.order_id)).length,
        pySum(upsVals),
        upsVals,
      ],
    ],
    ['revenue', [flag(hasInit || ups.length > 0), revVals.length, pySum(revVals), revVals]],
    ['add_to_cart', ev('add_to_cart')],
    ['begin_checkout', ev('begin_checkout')],
    ['add_shipping_info', ev('add_shipping_info', [])],
    ['add_payment_info', ev('add_payment_info', [])],
    ['generate_lead', ev('generate_lead', [])],
    ['sign_up', ev('sign_up', [])],
    ['page_view', ev('page_view', [])],
    ['units', [flag(hasInit), unitVals.length, pySum(unitVals), unitVals]],
    ['units_upsell', [flag(ups.length > 0), upsUnitVals.length, pySum(upsUnitVals), upsUnitVals]],
    ['units_added', [flag(carted.size > 0), pySum(carted.values()), 0.0, []]],
    ['units_bought_from_cart', [flag(fromCart.some((n) => n !== 0)), pySum(fromCart), 0.0, []]],
    ['coupon', [flag(couponOrders > 0), couponOrders, 0.0, []]],
    ['lead', [flag(lead), leadCount, 0.0, []]],
    ['lead_purchase', both(lead, hasInit)],
    ['repeat_purchase', both(init.length >= 2, true)],
    ['cart_purchase', both(by('add_to_cart').length > 0, hasInit)],
    ['checkout_purchase', both(by('begin_checkout').length > 0, hasInit)],
    ['session', [flag(sess.length > 0), sess.length, pySum(sess), sess]],
  ]);
  return (key) => {
    const hit = fixed.get(key);
    if (hit) return hit;
    // Generalised from generate.py's hardcoded `event:size_guide_opened` / `goal:12`.
    if (key.startsWith(EVENT_PREFIX)) return ev(key.slice(EVENT_PREFIX.length), []);
    if (key.startsWith(GOAL_PREFIX)) {
      const goalId = Number(key.slice(GOAL_PREFIX.length));
      if (!Number.isInteger(goalId)) throw new Error(`oracle: bad goal key ${key}`);
      const n = by('conversion').filter((e) => e.goal_id === goalId).length;
      return [flag(n > 0), n, 0.0, []];
    }
    throw new Error(`oracle: unknown summary key ${key}`);
  };
}

/** Top-10 dimension values by exposed-visitor count (ties: first-seen order). */
function topValues(m: Model, dimension: string): Set<unknown> {
  const cnt = new Map<unknown, number>();
  for (const x of m.exposed.values()) {
    const dv = pyTruthy(x.attrs[dimension]) ? x.attrs[dimension] : '(none)';
    cnt.set(dv, (cnt.get(dv) ?? 0) + 1);
  }
  const ranked = [...cnt].sort((a, b) => b[1] - a[1]);
  return new Set(ranked.slice(0, 10).map(([k]) => k));
}

interface Group {
  readonly date: string;
  readonly variationId: number;
  readonly dv: unknown;
  visitors: number;
}

interface Acc {
  readonly group: Group;
  readonly key: string;
  converted: number;
  count: number;
  sum: number;
  sumSq: number;
  sumSqVisitor: number;
}

function dimValue(
  attrs: Readonly<Record<string, unknown>>,
  dimension: string | null,
  top: Set<unknown> | null,
): unknown {
  if (dimension === null || top === null) return null;
  const raw = pyTruthy(attrs[dimension]) ? attrs[dimension] : '(none)';
  return top.has(raw) ? raw : '(other)';
}

export function dailySummary(m: Model, opts: DailySummaryOptions = {}): DailySummary {
  const keys = opts.keys ?? SUMMARY_KEYS;
  const dimension = opts.dimension ?? null;
  const capped = opts.capped ?? false;
  const top = dimension === null ? null : topValues(m, dimension);
  const groups = new Map<string, Group>();
  const acc = new Map<string, Acc>();
  for (const [vid, x] of m.exposed) {
    const dv = dimValue(x.attrs, dimension, top);
    const gk = JSON.stringify([x.date, x.variationId, dv]);
    const group = groups.get(gk) ?? { date: x.date, variationId: x.variationId, dv, visitors: 0 };
    group.visitors += 1;
    groups.set(gk, group);
    const vals = summaryValues(m, vid, capped);
    for (const k of keys) {
      const [c, n, s, units] = vals(k);
      const ak = JSON.stringify([gk, k]);
      const a = acc.get(ak) ?? {
        group,
        key: k,
        converted: 0,
        count: 0,
        sum: 0,
        sumSq: 0,
        sumSqVisitor: 0,
      };
      a.converted += c;
      a.count += n;
      a.sum += s;
      a.sumSq += pySum(units.map((u) => u * u));
      a.sumSqVisitor += s * s;
      acc.set(ak, a);
    }
  }
  return {
    experiment_id: m.expId,
    from: m.from,
    to: m.to,
    report_currency: m.ccy,
    date_basis: 'first_exposure',
    cap_outliers: capped,
    dimension,
    quality: { multi_variation_visitors: m.multi, variation_mismatch_events: m.mismatch },
    rows: sortAcc([...acc.values()], m.variations, keys).map((a) => toRow(a, dimension)),
  };
}

function compare(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function sortAcc(accs: Acc[], variations: readonly number[], keys: readonly string[]): Acc[] {
  const sortKey = (a: Acc): (string | number)[] => [
    a.group.date,
    pyStr(a.group.dv),
    variations.indexOf(a.group.variationId),
    keys.indexOf(a.key),
  ];
  for (const a of accs) {
    if (!variations.includes(a.group.variationId)) {
      throw new Error(`oracle: variation ${a.group.variationId} not in model variations`);
    }
  }
  return [...accs].sort((a, b) => compare(sortKey(a), sortKey(b)));
}

function toRow(a: Acc, dimension: string | null): DailySummaryRow {
  const head = { date: a.group.date, variation_id: a.group.variationId };
  const dim = dimension === null ? {} : { dimension, dimension_value: a.group.dv };
  return {
    ...head,
    ...dim,
    metric_key: a.key,
    visitors: a.group.visitors,
    converted: a.converted,
    count: a.count,
    sum: pyRound(a.sum, 2),
    sum_sq: pyRound(a.sumSq, 2),
    sum_sq_visitor: pyRound(a.sumSqVisitor, 2),
  };
}
