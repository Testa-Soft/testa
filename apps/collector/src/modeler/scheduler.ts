/**
 * Scheduler tick (PRD-006 §3.2), every MODELER_INTERVAL_SEC:
 *  - running: enqueue when the project has events newer than the last run's
 *    `data_through`, when no run ever finished or the last one failed, or when
 *    the last finished run is older than MODELER_MAX_RUN_AGE_SEC (24 h);
 *  - stopped: one final run (`is_final = 1`) per stop, at high priority.
 * Experiments already queued, waiting for a retry, or running are skipped.
 */
import type { ModelerContext } from './context.ts';
import { PRIORITY, type Priority, enqueue, isDelayed, position } from './queue.ts';
import { chToIso } from './refresh.ts';
import { readRunState, writeRunState } from './run-state.ts';
import { type Subscription, listSchedulable } from './subscriptions.ts';

/** An experiment is identified by both ids (R3: experiment ids repeat across projects). */
export interface ExperimentRef {
  projectId: number;
  experimentId: number;
}

async function newestByProject(
  ctx: ModelerContext,
  projectIds: number[],
): Promise<Map<number, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await ctx.query<{ project_id: string; newest: string }>(
    `SELECT project_id, toString(max(server_ts)) AS newest
     FROM events WHERE project_id IN {pids:Array(UInt64)} GROUP BY project_id`,
    { pids: projectIds },
  );
  return new Map(rows.map((r) => [Number(r.project_id), chToIso(r.newest)]));
}

async function inFlight(ctx: ModelerContext, sub: Subscription): Promise<boolean> {
  const job = {
    kind: 'refresh' as const,
    projectId: sub.projectId,
    experimentId: sub.experimentId,
  };
  const [pos, delayed, locked] = await Promise.all([
    position(ctx.redis, ctx.keys, job),
    isDelayed(ctx.redis, ctx.keys, job),
    ctx.redis.exists(ctx.keys.lock(sub.projectId, sub.experimentId)),
  ]);
  return pos !== null || delayed || locked > 0;
}

/** Enqueue a refresh and mark it queued (used by the scheduler and the sync API). */
export async function requestRefresh(
  ctx: ModelerContext,
  projectId: number,
  experimentId: number,
  priority: Priority,
): Promise<void> {
  const nowMs = ctx.now();
  const runKey = ctx.keys.run(projectId, experimentId);
  const state = await readRunState(ctx.redis, runKey);
  await enqueue(ctx.redis, ctx.keys, { kind: 'refresh', projectId, experimentId }, priority, nowMs);
  if (state.status !== 'running') {
    await writeRunState(ctx.redis, runKey, {
      status: 'queued',
      queued_at: new Date(nowMs).toISOString(),
      attempt: 0,
    });
  }
}

/** One scheduler pass; returns the experiments it enqueued. */
export async function tick(ctx: ModelerContext): Promise<ExperimentRef[]> {
  const subs = await listSchedulable(ctx.query);
  const newest = await newestByProject(ctx, [...new Set(subs.map((s) => s.projectId))]);
  const nowMs = ctx.now();
  const enqueued: ExperimentRef[] = [];
  for (const sub of subs) {
    if (await inFlight(ctx, sub)) continue;
    const state = await readRunState(ctx.redis, ctx.keys.run(sub.projectId, sub.experimentId));
    let priority: Priority | null = null;
    if (sub.status === 'stopped') {
      if (state.final_for !== sub.updatedAt) priority = PRIORITY.high;
    } else {
      const latest = newest.get(sub.projectId) ?? '';
      const stale =
        state.computed_at !== '' &&
        nowMs - Date.parse(state.computed_at) > ctx.settings.maxRunAgeSec * 1000;
      const newData = latest !== '' && (state.data_through === '' || latest > state.data_through);
      if (state.last_ready_run_id === '' || state.status === 'failed' || newData || stale) {
        priority = PRIORITY.scheduled;
      }
    }
    if (priority !== null) {
      await requestRefresh(ctx, sub.projectId, sub.experimentId, priority);
      enqueued.push({ projectId: sub.projectId, experimentId: sub.experimentId });
    }
  }
  return enqueued;
}
