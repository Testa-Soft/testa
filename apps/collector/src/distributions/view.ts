/**
 * `distributions` query view (PRD-006 §6.5, task 5.16): payment method share,
 * coupons, currencies and the order value histogram. Runs on the modeler queue
 * via `POST …/queries`. No stats: crobot calls `/api/v1/stats` if needed.
 */
import type { DistributionKey, DistributionsResult } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { type ViewTypes, registerView } from '../analytics/views.ts';
import { assertCurrency, assertRange } from '../modeler/daily-rows.ts';
import { DISTRIBUTION_KEYS, buildDistributions } from './build.ts';
import { fetchDistributionEvents, fetchOrderCap } from './query.ts';

type DistributionsParams = ViewTypes['distributions']['params'];

export const MAX_BINS = 50;

const bad = (field: string) => new SyncApiError('unknown_metric', 400, field);

function asRecord(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SyncApiError('unknown_view', 400, field);
  }
  return raw as Record<string, unknown>;
}

function parseKeys(raw: unknown): DistributionKey[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw bad('distributions');
  const keys = [...new Set(raw)];
  if (!keys.every((k) => DISTRIBUTION_KEYS.includes(k as DistributionKey)))
    throw bad('distributions');
  return keys as DistributionKey[];
}

/** Custom bins: 1–50 finite lower bounds ≥ 0, strictly ascending. */
function parseBins(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  const ok =
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.length <= MAX_BINS &&
    raw.every((b, i) => Number.isFinite(b) && b >= 0 && (i === 0 || b > (raw[i - 1] as number)));
  if (!ok) throw bad('order_value_bins');
  return raw as number[];
}

/** Throws the PRD §5.5 400 codes (`unknown_metric` with the bad field, `invalid_range`, …). */
export function validateDistributionsParams(raw: unknown): DistributionsParams {
  const body = asRecord(raw, 'params');
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  assertRange(from, to);
  if (body.filters !== undefined && Object.keys(asRecord(body.filters, 'filters')).length > 0) {
    throw new SyncApiError('unknown_dimension', 400, 'filters');
  }
  if (body.cap_outliers !== undefined && typeof body.cap_outliers !== 'boolean') {
    throw bad('cap_outliers');
  }
  const fields = {
    report_currency:
      body.report_currency === undefined ? undefined : assertCurrency(body.report_currency),
    distributions: parseKeys(body.distributions),
    order_value_bins: parseBins(body.order_value_bins),
    cap_outliers: body.cap_outliers as boolean | undefined,
  };
  // Drop absent optionals (exactOptionalPropertyTypes; canonical query_id).
  const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return { from, to, ...present } as DistributionsParams;
}

registerView('distributions', {
  validate: validateDistributionsParams,
  async run(ctx, params): Promise<DistributionsResult> {
    const reportCurrency = params.report_currency ?? ctx.reportCurrency;
    const scope = {
      projectId: ctx.projectId,
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
      reportCurrency,
    };
    const keys = params.distributions ?? DISTRIBUTION_KEYS;
    const wantsCap = params.cap_outliers === true && keys.includes('order_value');
    const [events, cap] = await Promise.all([
      fetchDistributionEvents(ctx.query, scope),
      wantsCap ? fetchOrderCap(ctx.query, scope) : Promise.resolve(undefined),
    ]);
    return buildDistributions({
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
      reportCurrency,
      variations: ctx.experiment.variations.map((v) => v.variation_id),
      keys,
      events,
      ...(params.order_value_bins === undefined ? {} : { bins: params.order_value_bins }),
      ...(cap === undefined ? {} : { cap }),
    });
  },
});
