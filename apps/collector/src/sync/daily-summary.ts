/**
 * `GET /api/v1/experiments/:id/daily-summary?project_id=[&since_run_id=]`
 * (PRD-006 §3.4; `project_id` required, R3).
 * Never computes: run state from Redis + the last ready run's rows from
 * `metric_daily`. `since_run_id` equal to the current run → `unchanged: true`.
 */
import type { DailyRow, DailySummaryResponse, MetricKey } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { readRunState } from '../modeler/run-state.ts';
import { readSubscription } from '../modeler/subscriptions.ts';
import { type SyncContext, refreshTiming, summaryStatus } from './context.ts';
import { requireOwned, requireOwnedV2 } from './ownership.ts';

interface StoredRow {
  d: string;
  variation_id: string;
  metric_key: string;
  visitors: string;
  converted: string;
  count: string;
  sum: number;
  sum_sq: number;
  sum_sq_visitor: number;
}

async function runRows(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
  runId: string,
): Promise<DailyRow[]> {
  const rows = await ctx.query<StoredRow>(
    `SELECT toString(date) AS d, variation_id, metric_key, visitors, converted, count, sum, sum_sq, sum_sq_visitor
     FROM metric_daily
     WHERE project_id = {p:UInt64} AND experiment_id = {e:UInt64} AND run_id = {r:String}
     ORDER BY date, variation_id, metric_key`,
    { p: projectId, e: experimentId, r: runId },
  );
  return rows.map((r) => ({
    date: r.d,
    variation_id: Number(r.variation_id),
    metric_key: r.metric_key as MetricKey,
    visitors: Number(r.visitors),
    converted: Number(r.converted),
    count: Number(r.count),
    sum: Number(r.sum),
    sum_sq: Number(r.sum_sq),
    sum_sq_visitor: Number(r.sum_sq_visitor),
  }));
}

export async function getDailySummary(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
  sinceRunId: string | undefined,
): Promise<DailySummaryResponse> {
  const sub = await readSubscription(ctx.query, projectId, experimentId);
  if (!sub || sub.status === 'deleted') {
    await requireOwned(ctx, projectId, experimentId);
    throw new SyncApiError('not_subscribed', 404);
  }
  await requireOwnedV2(ctx, projectId, experimentId);

  const state = await readRunState(ctx.redis, ctx.keys.run(projectId, experimentId));
  const status = summaryStatus(state);
  const finalDone = sub.status === 'stopped' && state.final_for === sub.updatedAt;
  const timing = await refreshTiming(ctx, sub.projectId, experimentId, state, { finalDone });
  const runId = state.last_ready_run_id || null;
  const unchanged = runId !== null && sinceRunId === runId;
  const rows = runId && !unchanged ? await runRows(ctx, sub.projectId, experimentId, runId) : [];
  const today = new Date(ctx.now()).toISOString().slice(0, 10);

  return {
    status,
    run_id: runId,
    computed_at: state.computed_at || null,
    data_through: state.data_through || null,
    next_run_at: timing.nextRunAt,
    retry_after: timing.retryAfter,
    experiment_id: experimentId,
    from: state.from || sub.from,
    to: state.to || (sub.to ?? today),
    report_currency: state.report_currency || sub.reportCurrency,
    date_basis: 'first_exposure',
    cap_outliers: false,
    dimension: null,
    quality: state.quality ?? { multi_variation_visitors: 0, variation_mismatch_events: 0 },
    rows,
    ...(unchanged ? { unchanged: true as const } : {}),
  };
}
