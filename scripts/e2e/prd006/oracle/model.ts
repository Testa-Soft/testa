/**
 * generate.py `model()`: exposures (merged view), purchase dedup, attribution
 * and the outlier cap. Port of the PRD-006 reference oracle.
 */

import type { RawEvent, RawItem, Sim } from '../raw.ts';
import { npPercentile, parseDay, parseTs } from './pymath.ts';

export const ORACLE_FX: Readonly<Record<string, number>> = Object.freeze({
  EUR: 1.0,
  USD: 0.9,
  GBP: 1.15,
});

const DAY_SECS = 86_400;
const CAP_PERCENTILE = 99;

/** Dimension snapshot keys copied from the first experiment_view. */
const SNAPSHOT_KEYS = [
  'channel',
  'referrer_domain',
  'country',
  'region',
  'city',
  'device_type',
  'os_name',
  'browser_name',
  'visit_number',
] as const;

/** One exposed visitor (generate.py `exposed[vid]`). */
export interface Exposure {
  readonly visitorId: string;
  readonly firstExposedAt: string;
  readonly variationId: number;
  /** `first_exposed_at[:10]` — the summary's date basis. */
  readonly date: string;
  /** Snapshot dims + utm_* + screen_resolution + visitor_type, keyed as in Python. */
  readonly attrs: Readonly<Record<string, unknown>>;
}

export interface Model {
  readonly expId: number;
  readonly from: string;
  readonly to: string;
  readonly variations: readonly number[];
  readonly weights: readonly number[];
  readonly ccy: string;
  /** Exposed visitors in Python dict insertion order. */
  readonly exposed: ReadonlyMap<string, Exposure>;
  /** Attributed events per visitor, purchases deduped by order_id. */
  readonly att: ReadonlyMap<string, readonly RawEvent[]>;
  /** Attributed events per visitor WITHOUT purchase dedup (health basis). */
  readonly attRaw: ReadonlyMap<string, readonly RawEvent[]>;
  readonly items: ReadonlyMap<string, readonly RawItem[]>;
  readonly multi: number;
  readonly mismatch: number;
  readonly cap: number;
}

interface ExpoAcc {
  readonly first: RawEvent;
  readonly seen: Set<number | null>;
}

export function fx(currency: string): number {
  const rate = ORACLE_FX[currency];
  if (rate === undefined) throw new Error(`oracle: no FX rate for currency ${currency}`);
  return rate;
}

export function expIndex(e: RawEvent, expId: number): number {
  const i = e.exp_ids.indexOf(expId);
  if (i < 0) throw new Error(`oracle: event ${e.event_id} lacks experiment ${expId}`);
  return i;
}

export function itemsOf(m: Model, e: RawEvent): readonly RawItem[] {
  return m.items.get(e.event_id) ?? [];
}

function sortedByClientTs(events: readonly RawEvent[]): RawEvent[] {
  // Stable, string order — Python `sorted(key=client_ts)`.
  return [...events].sort((a, b) =>
    a.client_ts < b.client_ts ? -1 : a.client_ts > b.client_ts ? 1 : 0,
  );
}

function collectExposures(sorted: readonly RawEvent[], expId: number): Map<string, ExpoAcc> {
  const expo = new Map<string, ExpoAcc>();
  for (const e of sorted) {
    if (e.event_name !== 'experiment_view' || e.is_bot || e.experiment_id !== expId) continue;
    const acc = expo.get(e.visitor_id) ?? { first: e, seen: new Set<number | null>() };
    acc.seen.add(e.variation_id);
    expo.set(e.visitor_id, acc);
  }
  return expo;
}

function snapshotAttrs(e: RawEvent): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const k of SNAPSHOT_KEYS) attrs[k] = e[k];
  attrs.utm_source = e.entry_utm_source;
  attrs.utm_medium = e.entry_utm_medium;
  attrs.utm_campaign = e.entry_utm_campaign;
  attrs.screen_resolution = `${e.screen_w}x${e.screen_h}`;
  return attrs;
}

function dedupPurchases(sorted: readonly RawEvent[]): RawEvent[] {
  const seen = new Set<string>();
  const out: RawEvent[] = [];
  for (const e of sorted) {
    if (e.event_name === 'purchase') {
      if (seen.has(e.order_id)) continue;
      seen.add(e.order_id);
    }
    out.push(e);
  }
  return out;
}

interface Attribution {
  readonly att: Map<string, RawEvent[]>;
  readonly mismatch: number;
}

function attribute(
  events: readonly RawEvent[],
  expId: number,
  exposed: ReadonlyMap<string, { readonly firstTs: number; readonly variationId: number }>,
  end: number,
): Attribution {
  const att = new Map<string, RawEvent[]>();
  let mismatch = 0;
  for (const e of events) {
    const x = exposed.get(e.visitor_id);
    if (e.is_bot || !e.exp_ids.includes(expId) || x === undefined) continue;
    const t = parseTs(e.client_ts);
    if (t >= end || t < x.firstTs) continue;
    const varId = e.exp_var_ids[expIndex(e, expId)];
    if (varId !== x.variationId && e.event_name !== 'experiment_view') mismatch += 1;
    const list = att.get(e.visitor_id) ?? [];
    list.push(e);
    att.set(e.visitor_id, list);
  }
  return { att, mismatch };
}

function indexItems(items: readonly RawItem[]): Map<string, RawItem[]> {
  const byEvent = new Map<string, RawItem[]>();
  for (const it of items) {
    const list = byEvent.get(it.event_id) ?? [];
    list.push(it);
    byEvent.set(it.event_id, list);
  }
  return byEvent;
}

function visitorType(events: readonly RawEvent[], expId: number): string {
  const starts = new Set<number | undefined>();
  for (const e of events) starts.add(e.exp_session_starts[expIndex(e, expId)]);
  return starts.size >= 2 ? 'returning' : 'new';
}

function capThreshold(att: ReadonlyMap<string, readonly RawEvent[]>): number {
  const ov: number[] = [];
  for (const es of att.values()) {
    for (const e of es) {
      if (e.event_name === 'purchase' && e.purchase_type === 'initial') {
        ov.push(e.value_native * fx(e.currency));
      }
    }
  }
  return ov.length > 0 ? npPercentile(ov, CAP_PERCENTILE) : 0.0;
}

export function buildModel(
  sim: Sim,
  expId: number,
  from: string,
  to: string,
  variations: number[],
  weights: number[],
  ccy = 'EUR',
): Model {
  const end = parseDay(to) + DAY_SECS;
  const fromd = parseDay(from);
  const sorted = sortedByClientTs(sim.events);
  const expo = collectExposures(sorted, expId);
  let multi = 0;
  const window = new Map<string, { firstTs: number; variationId: number; first: RawEvent }>();
  for (const [vid, acc] of expo) {
    if (acc.seen.size > 1) multi += 1;
    const firstTs = parseTs(acc.first.client_ts);
    if (acc.seen.size === 1 && fromd <= firstTs && firstTs < end) {
      const variationId = acc.first.variation_id;
      if (variationId === null) throw new Error('oracle: experiment_view without variation');
      window.set(vid, { firstTs, variationId, first: acc.first });
    }
  }
  const { att, mismatch } = attribute(dedupPurchases(sorted), expId, window, end);
  const { att: attRaw } = attribute(sorted, expId, window, end);
  const exposed = new Map<string, Exposure>();
  for (const [vid, w] of window) {
    exposed.set(vid, {
      visitorId: vid,
      firstExposedAt: w.first.client_ts,
      variationId: w.variationId,
      date: w.first.client_ts.slice(0, 10),
      attrs: {
        ...snapshotAttrs(w.first),
        visitor_type: visitorType(att.get(vid) ?? [], expId),
      },
    });
  }
  return {
    expId,
    from,
    to,
    variations: [...variations],
    weights: [...weights],
    ccy,
    exposed,
    att,
    attRaw,
    items: indexItems(sim.items),
    multi,
    mismatch,
    cap: capThreshold(att),
  };
}
