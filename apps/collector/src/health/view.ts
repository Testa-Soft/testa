/**
 * `health` query view (PRD-006 §6.5, task 5.17): the Data health tab and the
 * Summary "Tracking" card. Runs on the modeler queue via `POST …/queries`.
 */
import type { HealthResult } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { type ViewTypes, registerView } from '../analytics/views.ts';
import { assertCurrency, assertRange } from '../modeler/daily-rows.ts';
import { buildHealth } from './build.ts';
import { fetchHealthRows } from './query.ts';

type HealthParams = ViewTypes['health']['params'];

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SyncApiError('unknown_view', 400, 'params');
  }
  return raw as Record<string, unknown>;
}

export function validateHealthParams(raw: unknown): HealthParams {
  const body = asRecord(raw);
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  assertRange(from, to);
  // Health has no money; the currency is accepted (envelope field) but unused.
  const params: HealthParams = { from, to };
  if (body.report_currency !== undefined) {
    params.report_currency = assertCurrency(body.report_currency);
  }
  // Filters are part of the contract but not supported by the MVP query yet.
  if (body.filters !== undefined && Object.keys(asRecord(body.filters)).length > 0) {
    throw new SyncApiError('unknown_dimension', 400, 'filters');
  }
  return params;
}

registerView('health', {
  validate: validateHealthParams,
  async run(ctx, params): Promise<HealthResult> {
    const rows = await fetchHealthRows(ctx.query, {
      projectId: ctx.projectId,
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
    });
    return buildHealth({
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
      variations: ctx.experiment.variations.map((v) => ({ id: v.variation_id, weight: v.weight })),
      rows,
    });
  },
});
