/**
 * `PUT|DELETE /api/v1/experiments/:id/subscription` (PRD-006 §3.1), keyed by
 * `(project_id, experiment_id)` (R3): `project_id` in the PUT body, or
 * `?project_id=` on DELETE. Idempotent, latest wins. A new subscription, a changed metric list / range / currency,
 * or a stop enqueues a refresh at high priority right away.
 */
import type { SubscriptionResponse } from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { PRIORITY } from '../modeler/queue.ts';
import { readRunState } from '../modeler/run-state.ts';
import { requestRefresh } from '../modeler/scheduler.ts';
import {
  type Subscription,
  chDateTime,
  readSubscription,
  writeSubscription,
} from '../modeler/subscriptions.ts';
import { type SyncContext, refreshTiming, summaryStatus } from './context.ts';
import { requireOwned, requireOwnedV2 } from './ownership.ts';
import { validateSubscription } from './validate.ts';

function changed(prev: Subscription | null, next: Subscription): boolean {
  return (
    prev === null ||
    prev.status !== next.status ||
    prev.projectId !== next.projectId ||
    prev.from !== next.from ||
    prev.to !== next.to ||
    prev.reportCurrency !== next.reportCurrency ||
    prev.metrics.join(',') !== next.metrics.join(',')
  );
}

export async function putSubscription(
  ctx: SyncContext,
  experimentId: number,
  raw: unknown,
): Promise<SubscriptionResponse> {
  const body = validateSubscription(raw);
  await requireOwnedV2(ctx, body.projectId, experimentId);

  const prev = await readSubscription(ctx.query, body.projectId, experimentId);
  const next: Subscription = {
    projectId: body.projectId,
    experimentId,
    status: body.status,
    from: body.from,
    to: body.to,
    reportCurrency: body.reportCurrency,
    metrics: body.metrics,
    updatedAt: chDateTime(new Date(ctx.now())),
  };
  const mustRun = changed(prev, next);
  // Unchanged repeat PUT: keep the stored row (and its updated_at, which the final run keys on).
  if (mustRun) {
    await writeSubscription(ctx.insert, next);
    await requestRefresh(ctx, next.projectId, experimentId, PRIORITY.high);
  }
  const current = mustRun ? next : (prev as Subscription);
  const state = await readRunState(ctx.redis, ctx.keys.run(current.projectId, experimentId));
  const finalDone = current.status === 'stopped' && state.final_for === current.updatedAt;
  const timing = await refreshTiming(ctx, current.projectId, experimentId, state, { finalDone });
  return { status: summaryStatus(state), next_run_at: timing.nextRunAt };
}

export async function deleteSubscription(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
): Promise<SubscriptionResponse> {
  const prev = await readSubscription(ctx.query, projectId, experimentId);
  if (!prev || prev.status === 'deleted') {
    await requireOwned(ctx, projectId, experimentId);
    throw new SyncApiError('not_subscribed', 404);
  }
  await writeSubscription(ctx.insert, {
    ...prev,
    status: 'deleted',
    updatedAt: chDateTime(new Date(ctx.now())),
  });
  const state = await readRunState(ctx.redis, ctx.keys.run(projectId, experimentId));
  return { status: summaryStatus(state), next_run_at: null };
}
