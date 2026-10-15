/**
 * generate.py `health()` + `srm()`.
 *
 * INTENTIONAL DEVIATION: generate.py's health() says "health counts raw
 * attributed events (duplicates included)" but iterates the purchase-deduped
 * `M["att"]`. Health here counts `m.attRaw` — the same exposure / window / bot /
 * experiment rules, without the order_id dedup — so thank-you reload duplicates
 * are counted. Everything else matches the oracle.
 */

import type { RawEvent } from '../raw.ts';
import type { Model } from './model.ts';
import { itemsOf } from './model.ts';
import { erfc, pyRound, pySum, r6, ratio } from './pymath.ts';

const PARAM_OK_PCT = 0.95;
const SRM_ALPHA = 0.001;

const EVENT_PARAM_SPEC: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'purchase',
    [
      'order_id',
      'value_native',
      'currency',
      'items',
      'items[].item_id',
      'items[].price',
      'items[].quantity',
      'purchase_type',
    ],
  ],
  ['add_to_cart', ['items', 'items[].item_id', 'items[].price']],
  ['add_payment_info', ['payment_type']],
  ['begin_checkout', []],
  ['add_shipping_info', []],
  ['experiment_view', []],
  ['page_view', []],
];

const METRIC_NEEDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['cr', ['purchase']],
  ['aov', ['purchase']],
  ['rpv', ['purchase']],
  ['add_to_cart_rate', ['add_to_cart']],
  ['buy_to_cart', ['add_to_cart', 'purchase']],
  ['payment_load_rate', ['add_payment_info']],
  ['step_payment_to_purchase', ['add_payment_info', 'purchase']],
  ['avg_item_price', ['purchase']],
];

export interface SrmResult {
  readonly expected_weights: Readonly<Record<string, number>>;
  readonly chi2: number;
  readonly p_value: number;
  readonly ok: boolean;
}

/** generate.py `srm(M, ids)` over the given (default: all exposed) visitors. */
export function srm(m: Model, ids: readonly string[] = [...m.exposed.keys()]): SrmResult {
  const obs = m.variations.map(
    (v) => ids.filter((vid) => m.exposed.get(vid)?.variationId === v).length,
  );
  const tot = pySum(obs);
  const w = m.weights;
  const chi2 =
    tot > 0
      ? pySum(
          obs.map((o, i) => {
            const wi = w[i] ?? 0;
            return (o - tot * wi) ** 2 / (tot * wi);
          }),
        )
      : 0.0;
  const df = obs.length - 1;
  let p: number;
  if (df === 2) p = Math.exp(-chi2 / 2);
  else if (df === 1) p = erfc(Math.sqrt(chi2 / 2));
  else throw new Error(`oracle: srm p-value only defined for 2 or 3 variations (df=${df})`);
  const expected: Record<string, number> = {};
  m.variations.forEach((v, i) => {
    expected[String(v)] = pyRound(w[i] ?? 0, 4);
  });
  return {
    expected_weights: expected,
    chi2: pyRound(chi2, 4),
    p_value: pyRound(p, 4),
    ok: p >= SRM_ALPHA,
  };
}

function presentPct(m: Model, es: readonly RawEvent[], p: string): number | null {
  if (p.startsWith('items[].')) {
    const f = p.slice('items[].'.length);
    const its = es.flatMap((e) => itemsOf(m, e));
    const present = its.filter((it) => it[f] !== null && it[f] !== undefined).length;
    return ratio(present, its.length);
  }
  if (p === 'items') return ratio(es.filter((e) => itemsOf(m, e).length > 0).length, es.length);
  if (p === 'payment_type') {
    return ratio(es.filter((e) => Boolean(e.props.payment_type)).length, es.length);
  }
  // Python `e.get(p) not in (None, "", 0)`.
  const present = es.filter((e) => {
    const v = e[p];
    return v !== null && v !== undefined && v !== '' && v !== 0 && v !== false;
  }).length;
  return ratio(present, es.length);
}

function eventHealth(m: Model, name: string, req: readonly string[]) {
  const es: RawEvent[] = [];
  for (const l of m.attRaw.values()) for (const e of l) if (e.event_name === name) es.push(e);
  const evBy: Record<string, number> = {};
  const visBy = new Map<string, Set<string>>();
  for (const v of m.variations) {
    evBy[String(v)] = 0;
    visBy.set(String(v), new Set());
  }
  for (const e of es) {
    const v = String(m.exposed.get(e.visitor_id)?.variationId);
    const vis = visBy.get(v);
    if (!vis) throw new Error(`oracle: variation ${v} not in model variations`);
    evBy[v] = (evBy[v] ?? 0) + 1;
    vis.add(e.visitor_id);
  }
  const params = req.map((p) => ({
    param: p,
    required: true,
    present_pct: r6(presentPct(m, es, p)),
  }));
  const status =
    es.length === 0
      ? 'missing'
      : params.some((x) => (x.present_pct ?? 0) < PARAM_OK_PCT)
        ? 'warning'
        : 'ok';
  let last: string | null = null;
  for (const e of es) if (last === null || e.client_ts > last) last = e.client_ts;
  const visitors: Record<string, number> = {};
  for (const [v, s] of visBy) visitors[v] = s.size;
  return { event_name: name, status, last_event_at: last, events: evBy, visitors, params };
}

export function health(m: Model) {
  const out = EVENT_PARAM_SPEC.map(([name, req]) => eventHealth(m, name, req));
  const st = new Map(out.map((e) => [e.event_name, e.status]));
  const metrics = METRIC_NEEDS.map(([key, ev]) => ({
    key,
    availability: ev.some((n) => st.get(n) === 'missing')
      ? 'unavailable'
      : ev.some((n) => st.get(n) === 'warning')
        ? 'limited'
        : 'full',
    reason: ev
      .filter((n) => st.get(n) !== 'ok')
      .map((n) => `${n}: ${st.get(n)}`)
      .join(', '),
  }));
  return {
    experiment_id: m.expId,
    from: m.from,
    to: m.to,
    events: out,
    metrics,
    srm: srm(m),
    summary: {
      events_receiving: out.filter((e) => e.status !== 'missing').length,
      events_expected: out.length,
      param_warnings: out.filter((e) => e.status === 'warning').length,
      metrics_full: metrics.filter((x) => x.availability === 'full').length,
      metrics_limited: metrics.filter((x) => x.availability === 'limited').length,
    },
  };
}
