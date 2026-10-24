import type { ModelerContext } from './context.ts';
/**
 * One refresh run (PRD-006 §3.2): model the subscription's full
 * `[from, to ?? today]` range, insert the rows under a fresh `run_id`, then
 * flip `last_ready_run_id` so readers switch to the whole new run at once.
 */
import { computeDailyRows } from './daily-rows.ts';
import { configForProject } from './project-config.ts';
import { recordDuration } from './queue.ts';
import { writeRunState } from './run-state.ts';
import { chDateTime, readSubscription } from './subscriptions.ts';
import { newRunId } from './ulid.ts';

const todayUtc = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** `YYYY-MM-DD hh:mm:ss.sss` (UTC) → ISO-8601. */
export const chToIso = (s: string): string => new Date(`${s.replace(' ', 'T')}Z`).toISOString();

async function newestEvent(ctx: ModelerContext, projectId: number): Promise<string> {
  const [row] = await ctx.query<{ newest: string; n: string }>(
    'SELECT toString(max(server_ts)) AS newest, count() AS n FROM events WHERE project_id = {p:UInt64}',
    { p: projectId },
  );
  return row && Number(row.n) > 0 ? chToIso(row.newest) : '';
}

async function variationOrder(ctx: ModelerContext, projectId: number, experimentId: number) {
  const config = await configForProject(ctx.configStore, projectId).catch(() => null);
  const exp = config?.experiments.find((e) => e.experiment_id === experimentId);
  return exp?.variations.map((v) => v.variation_id);
}

export type RefreshOutcome = 'ready' | 'skipped';

/** Throws on failure; the worker owns retries and the attempt counter. */
export async function runRefresh(
  ctx: ModelerContext,
  projectId: number,
  experimentId: number,
): Promise<RefreshOutcome> {
  const runKey = ctx.keys.run(projectId, experimentId);
  const sub = await readSubscription(ctx.query, projectId, experimentId);
  if (!sub || sub.status === 'deleted') return 'skipped';

  const startedMs = ctx.now();
  const runId = newRunId(startedMs);
  await writeRunState(ctx.redis, runKey, {
    status: 'running',
    run_id: runId,
    started_at: new Date(startedMs).toISOString(),
  });

  const to = sub.to ?? todayUtc(startedMs);
  const [dataThrough, order] = await Promise.all([
    newestEvent(ctx, projectId),
    variationOrder(ctx, projectId, experimentId),
  ]);
  const result = await computeDailyRows(ctx.query, {
    projectId,
    experimentId,
    from: sub.from,
    to,
    reportCurrency: sub.reportCurrency,
    metrics: sub.metrics,
    ...(order ? { variationOrder: order } : {}),
  });

  const computedMs = ctx.now();
  const isFinal = sub.status === 'stopped' ? 1 : 0;
  await ctx.insert(
    'metric_daily',
    result.rows.map((r) => ({
      project_id: projectId,
      experiment_id: experimentId,
      run_id: runId,
      computed_at: chDateTime(new Date(computedMs)),
      is_final: isFinal,
      date: r.date,
      variation_id: r.variation_id,
      metric_key: r.metric_key,
      visitors: r.visitors,
      converted: r.converted,
      count: r.count,
      sum: r.sum,
      sum_sq: r.sum_sq,
      sum_sq_visitor: r.sum_sq_visitor,
      count_sq_visitor: r.count_sq_visitor,
    })),
  );

  const computedAt = new Date(computedMs).toISOString();
  await writeRunState(ctx.redis, runKey, {
    status: 'ready',
    last_ready_run_id: runId,
    computed_at: computedAt,
    data_through: dataThrough,
    error: '',
    attempt: 0,
    quality: result.quality,
    from: sub.from,
    to,
    report_currency: sub.reportCurrency,
    ...(isFinal ? { final_for: sub.updatedAt } : {}),
  });
  await recordDuration(ctx.redis, ctx.keys, computedMs - startedMs);
  ctx.webhook.send({
    event: 'summary-ready',
    project_id: projectId,
    experiment_id: experimentId,
    run_id: runId,
    computed_at: computedAt,
    data_through: dataThrough || computedAt,
  });
  return 'ready';
}
