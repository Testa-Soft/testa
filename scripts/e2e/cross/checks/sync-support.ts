/** Helpers for the crobot ↔ platform sync checks: read crobot's MySQL state, map ids. */

import { type Ctx, PendingError } from '../lib/check.ts';
import type { RowLike } from '../lib/derive.ts';
import { type ArtisanResult, e2eArtisan } from '../stack/crobot.ts';

/** crobot keys every v2 subscription carries (crobot PRD §7a). */
export const CROBOT_CORE_METRICS = [
  'purchase',
  'upsell',
  'revenue',
  'add_to_cart',
  'begin_checkout',
  'add_shipping_info',
  'add_payment_info',
  'generate_lead',
  'sign_up',
  'lead',
  'units',
  'units_added',
  'units_bought_from_cart',
  'coupon',
  'lead_purchase',
  'repeat_purchase',
  'cart_purchase',
  'checkout_purchase',
] as const;

/** Per experiment identifier: crobot variations.id → platform variation id (E2EAnalyticsSeeder). */
const SEEDED_VARIATIONS: Readonly<Record<number, Readonly<Record<number, number>>>> = {
  1717: { 6001: 100, 6002: 101 },
  1802: { 6003: 200, 6004: 201 },
  1903: { 6005: 100, 6006: 101, 6007: 102 },
};

/** crobot variations.id → platform variation id, over every seeded experiment. */
const CROBOT_VARIATION_PK: Readonly<Record<number, number>> = Object.assign(
  {},
  ...Object.values(SEEDED_VARIATIONS),
);

/**
 * crobot variations.id of a platform variation identifier within one
 * experiment (identifiers repeat across experiments: 100/101 are in 1717 and 1903).
 */
export function crobotVariationPk(experimentId: number, identifier: number): number {
  const entry = Object.entries(SEEDED_VARIATIONS[experimentId] ?? {}).find(
    ([, id]) => id === identifier,
  );
  if (entry === undefined)
    throw new Error(`no seeded crobot variation for ${experimentId}/${identifier}`);
  return Number(entry[0]);
}

/** crobot experiments.id for a platform experiment id (E2EAnalyticsSeeder). */
export const CROBOT_EXPERIMENT_PK: Readonly<Record<number, number>> = {
  1717: 5001,
  1802: 5002,
  1903: 5003,
  1900: 5004,
};

export interface CrobotState {
  readonly metricSummary: readonly RowLike[];
  /** Raw rows used the crobot variations.id instead of the platform id. */
  readonly usedCrobotVariationIds: boolean;
  readonly syncState: Readonly<Record<string, unknown>> | null;
  readonly queryResults: readonly Readonly<Record<string, unknown>>[];
}

/** Run an e2e:analytics action; pending → PendingError(CB), error → Error. */
export async function crobotAction(
  ctx: Ctx,
  action: string,
  experiment?: number,
): Promise<ArtisanResult> {
  const res = await e2eArtisan(ctx.cfg, action, experiment);
  if (res.pending)
    throw new PendingError('CB', `crobot e2e:analytics ${action}: ${res.error ?? 'not built'}`);
  if (!res.ok)
    throw new Error(`crobot e2e:analytics ${action} failed: ${res.error} ${String(res.at ?? '')}`);
  return res;
}

const num = (v: unknown): number => Number(v ?? 0);

export async function crobotState(ctx: Ctx, experiment: number): Promise<CrobotState> {
  const res = await crobotAction(ctx, 'state', experiment);
  const raw = res.metric_summary as readonly Record<string, unknown>[] | null;
  if (raw === null)
    throw new PendingError('CB', 'crobot table metric_summary missing (C1 migrations)');
  let usedCrobotIds = false;
  const metricSummary = raw.map((r) => {
    let variation = num(r.variation_id);
    const mapped = CROBOT_VARIATION_PK[variation];
    if (mapped !== undefined) {
      usedCrobotIds = true;
      variation = mapped;
    }
    return {
      date: String(r.date).slice(0, 10),
      variation_id: variation,
      metric_key: String(r.metric_key),
      visitors: num(r.visitors),
      converted: num(r.converted),
      count: num(r.count),
      sum: num(r.sum),
      sum_sq: num(r.sum_sq),
      sum_sq_visitor: num(r.sum_sq_visitor),
      run_id: r.run_id,
    };
  });
  const states = res.analytics_sync_state as readonly Record<string, unknown>[] | null;
  return {
    metricSummary,
    usedCrobotVariationIds: usedCrobotIds,
    syncState: states?.[0] ?? null,
    queryResults: (res.analytics_query_results as readonly Record<string, unknown>[] | null) ?? [],
  };
}

/** JSON column (string or object) → value. */
export function jsonCol(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
