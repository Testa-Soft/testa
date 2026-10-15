/**
 * Pure assembly of `HealthResult` (PRD-006 §6.5) from the rows of
 * `fetchHealthRows`: per-event status and param coverage, metric availability,
 * SRM and the summary counts. Mirrors the oracle `generate.py health()`.
 */
import {
  type ByVariation,
  EVENT_PARAM_SPEC,
  type HealthEvent,
  type HealthEventName,
  type HealthMetric,
  type HealthResult,
  type SrmResult,
} from '@testa-platform/shared-types';
import { srmChiSquare } from '../stats/index.ts';
import type { EventParam, EventRow, HealthRows, ItemField, ItemRow } from './query.ts';

/** §6.5: a required param below this share of events → `warning`. */
export const PARAM_WARNING_THRESHOLD = 0.95;
/** §6.4: SRM is healthy while p ≥ 0.001. */
export const SRM_ALPHA = 0.001;

/** Dashboard metrics and the events they need (oracle `needs`). */
export const METRIC_EVENTS: Readonly<Record<string, readonly HealthEventName[]>> = {
  cr: ['purchase'],
  aov: ['purchase'],
  rpv: ['purchase'],
  add_to_cart_rate: ['add_to_cart'],
  buy_to_cart: ['add_to_cart', 'purchase'],
  payment_load_rate: ['add_payment_info'],
  step_payment_to_purchase: ['add_payment_info', 'purchase'],
  avg_item_price: ['purchase'],
};

export interface HealthInput {
  experimentId: number;
  from: string;
  to: string;
  /** Config variations in config order, with their traffic weights. */
  variations: { id: number; weight: number }[];
  rows: HealthRows;
}

/** Oracle precision for shares (`r6`). */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function buildHealth(input: HealthInput): HealthResult {
  const ids = variationIds(input);
  const events = (Object.keys(EVENT_PARAM_SPEC) as HealthEventName[]).map((name) =>
    buildEvent(
      name,
      ids,
      input.rows.events.filter((r) => r.event_name === name),
      input.rows.items.find((r) => r.event_name === name),
    ),
  );
  const metrics = buildMetrics(events);
  return {
    experiment_id: input.experimentId,
    from: input.from,
    to: input.to,
    events,
    metrics,
    srm: buildSrm(input),
    summary: {
      events_receiving: events.filter((e) => e.status !== 'missing').length,
      events_expected: events.length,
      param_warnings: events.filter((e) => e.status === 'warning').length,
      metrics_full: metrics.filter((m) => m.availability === 'full').length,
      metrics_limited: metrics.filter((m) => m.availability === 'limited').length,
    },
  };
}

/** Config order first; a variation seen in data but missing from config is appended, not dropped. */
function variationIds(input: HealthInput): number[] {
  const ids = input.variations.map((v) => v.id);
  const seen = [
    ...input.rows.events.map((r) => r.variation_id),
    ...input.rows.exposed.map((r) => r.variation_id),
  ];
  return [...ids, ...[...new Set(seen)].filter((id) => !ids.includes(id)).sort((a, b) => a - b)];
}

function byVariation(ids: number[], value: (id: number) => number): ByVariation<number> {
  return Object.fromEntries(ids.map((id) => [String(id), value(id)]));
}

function buildEvent(
  name: HealthEventName,
  ids: number[],
  rows: EventRow[],
  items: ItemRow | undefined,
): HealthEvent {
  const total = rows.reduce((s, r) => s + r.events, 0);
  const params = EVENT_PARAM_SPEC[name].map((param) => ({
    param,
    required: true,
    present_pct: coverage(param, total, rows, items),
  }));
  const status: HealthEvent['status'] =
    total === 0
      ? 'missing'
      : params.some((p) => (p.present_pct ?? 0) < PARAM_WARNING_THRESHOLD)
        ? 'warning'
        : 'ok';
  const last = rows.map((r) => r.last_event_at).sort();
  return {
    event_name: name,
    status,
    last_event_at: last.at(-1) ?? null,
    events: byVariation(ids, (id) => rows.find((r) => r.variation_id === id)?.events ?? 0),
    visitors: byVariation(ids, (id) => rows.find((r) => r.variation_id === id)?.visitors ?? 0),
    params,
  };
}

/** Share of events (or of their item rows, for `items[].*`) carrying the param; null without events. */
function coverage(
  param: string,
  totalEvents: number,
  rows: EventRow[],
  items: ItemRow | undefined,
): number | null {
  if (totalEvents === 0) return null;
  if (param.startsWith('items[].')) {
    const field = param.slice('items[].'.length) as ItemField;
    if (!items || items.items === 0) return null;
    return round6(items.present[field] / items.items);
  }
  const present = rows.reduce((s, r) => s + r.present[param as EventParam], 0);
  return round6(present / totalEvents);
}

function buildMetrics(events: HealthEvent[]): HealthMetric[] {
  const status = new Map(events.map((e) => [e.event_name, e.status]));
  return Object.entries(METRIC_EVENTS).map(([key, needs]) => {
    const states = needs.map((n) => [n, status.get(n) ?? 'missing'] as const);
    const availability: HealthMetric['availability'] = states.some(([, s]) => s === 'missing')
      ? 'unavailable'
      : states.some(([, s]) => s === 'warning')
        ? 'limited'
        : 'full';
    const reason = states
      .filter(([, s]) => s !== 'ok')
      .map(([n, s]) => `${n}: ${s}`)
      .join(', ');
    return { key, availability, reason };
  });
}

/**
 * χ² of exposed visitors vs configured weights (P3's `srmChiSquare`). Only
 * positive-weight variations take part; with fewer than two, or no visitors,
 * there is nothing to test (χ² 0, p 1).
 */
function buildSrm(input: HealthInput): SrmResult {
  const weighted = input.variations.filter((v) => v.weight > 0);
  const weightSum = weighted.reduce((s, v) => s + v.weight, 0);
  const expected_weights = Object.fromEntries(
    weighted.map((v) => [String(v.id), v.weight / weightSum]),
  );
  const observed = weighted.map(
    (v) => input.rows.exposed.find((r) => r.variation_id === v.id)?.visitors ?? 0,
  );
  if (weighted.length < 2 || observed.every((o) => o === 0)) {
    return { chi2: 0, p_value: 1, ok: true, expected_weights };
  }
  const { chi2, p_value } = srmChiSquare(
    observed,
    weighted.map((v) => v.weight),
  );
  return { chi2, p_value, ok: p_value >= SRM_ALPHA, expected_weights };
}
