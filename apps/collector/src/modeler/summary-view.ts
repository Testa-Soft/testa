/**
 * The `summary` query view (PRD-006 §3.5, §6.3): daily rows for any metric
 * list, optionally split by one dimension (top 10 + `(other)`) or with p99
 * outlier capping. `payment_type` splits only `add_payment_info` + `purchase`
 * and marks rows `post_exposure: true`.
 */
import type { MetricKey, SummaryResult } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { type ViewTypes, registerView } from '../analytics/views.ts';
import { assertCurrency, assertRange, computeDailyRows } from './daily-rows.ts';
import { parseDimension, parseMetrics } from './metric-keys.ts';

type SummaryParams = ViewTypes['summary']['params'];

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SyncApiError('unknown_view', 400, 'params');
  }
  return raw as Record<string, unknown>;
}

export function validateSummaryParams(raw: unknown): SummaryParams {
  const body = asRecord(raw);
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  assertRange(from, to);
  const metrics = parseMetrics(body.metrics).map((k) => k.key);
  const params: SummaryParams = { from, to, metrics };
  if (body.dimension !== undefined && body.dimension !== null) {
    params.dimension = parseDimension(body.dimension);
  }
  if (body.cap_outliers !== undefined) {
    if (typeof body.cap_outliers !== 'boolean') {
      throw new SyncApiError('unknown_metric', 400, 'cap_outliers');
    }
    params.cap_outliers = body.cap_outliers;
  }
  if (body.report_currency !== undefined)
    params.report_currency = assertCurrency(body.report_currency);
  // Filters are part of the contract but not supported by the MVP query yet.
  if (body.filters !== undefined && Object.keys(asRecord(body.filters)).length > 0) {
    throw new SyncApiError('unknown_dimension', 400, 'filters');
  }
  return params;
}

registerView('summary', {
  validate: validateSummaryParams,
  async run(ctx, params): Promise<SummaryResult> {
    const reportCurrency = params.report_currency ?? ctx.reportCurrency;
    const capOutliers = params.cap_outliers ?? false;
    const result = await computeDailyRows(ctx.query, {
      projectId: ctx.projectId,
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
      reportCurrency,
      metrics: params.metrics as readonly MetricKey[],
      capOutliers,
      variationOrder: ctx.experiment.variations.map((v) => v.variation_id),
      ...(params.dimension === undefined ? {} : { dimension: params.dimension }),
    });
    const meta = {
      experiment_id: ctx.experimentId,
      from: params.from,
      to: params.to,
      report_currency: reportCurrency,
      date_basis: 'first_exposure' as const,
      cap_outliers: capOutliers,
      quality: result.quality,
    };
    return result.dimension === null
      ? { ...meta, dimension: null, rows: result.rows }
      : { ...meta, dimension: result.dimension, rows: result.rows };
  },
});
