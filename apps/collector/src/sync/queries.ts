/**
 * On-demand queries (PRD-006 §3.5), scoped to `(project_id, experiment_id)` (R3):
 *   POST /api/v1/experiments/:id/queries                     → 200 ready (cached, refresh=false) | 202 accepted
 *   GET  /api/v1/experiments/:id/queries/:queryId?project_id= → status + rows (summary) / result (other views)
 * Body checks (400) run before the ownership / version lookups (404 / 409),
 * as on PUT subscription.
 * Limits (§5.5): 60 POSTs/min and 200 pending queries per project → 429.
 */
import type {
  QueryAccepted,
  QueryRequest,
  QueryResponse,
  SummaryResult,
  SyncStatus,
  ViewName,
} from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { VIEW_NAMES, getView } from '../analytics/views.ts';
import { type StoredQuery, queryId, readQuery, submitQuery } from '../modeler/query-jobs.ts';
import { clampRetry, retryAfter } from '../modeler/queue.ts';
import { readSubscription } from '../modeler/subscriptions.ts';
import type { SyncContext } from './context.ts';
import { requireOwned, requireOwnedV2 } from './ownership.ts';
import { asObject, parseProjectId } from './validate.ts';

export const QUERY_RATE_PER_MIN = 60;
export const MAX_PENDING_QUERIES = 200;

export type PostQueryResult =
  | { httpStatus: 200; body: QueryResponse }
  | { httpStatus: 202; body: QueryAccepted };

const isView = (v: unknown): v is ViewName =>
  typeof v === 'string' && (VIEW_NAMES as readonly string[]).includes(v);

async function enforceRate(ctx: SyncContext, projectId: number): Promise<void> {
  const minute = Math.floor(ctx.now() / 60_000);
  const key = ctx.keys.queryRate(projectId, minute);
  const n = await ctx.redis.incr(key);
  if (n === 1) await ctx.redis.expire(key, 120);
  if (n > QUERY_RATE_PER_MIN) throw new SyncApiError('too_many_queries', 429);
}

/** Validate the body (envelope + per-view params) into a canonical QueryRequest. */
async function validateQuery(
  ctx: SyncContext,
  experimentId: number,
  raw: unknown,
): Promise<QueryRequest> {
  const body = asObject(raw, new SyncApiError('unknown_view', 400, 'body'));
  if (!isView(body.view)) throw new SyncApiError('unknown_view', 400, 'view');
  const projectId = parseProjectId(body.project_id);
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') {
    throw new SyncApiError('unknown_view', 400, 'refresh');
  }
  const { view, project_id: _p, refresh, ...rest } = body;
  const params = getView(view).validate(rest) as Record<string, unknown>;
  await requireOwnedV2(ctx, projectId, experimentId);
  if (params.report_currency === undefined) {
    const sub = await readSubscription(ctx.query, projectId, experimentId);
    if (!sub || sub.status === 'deleted')
      throw new SyncApiError('invalid_currency', 400, 'report_currency');
  }
  return {
    ...params,
    view,
    project_id: projectId,
    ...(refresh === undefined ? {} : { refresh }),
  } as QueryRequest;
}

function queryStatus(stored: StoredQuery): SyncStatus {
  return stored.status;
}

async function queryRetryAfter(ctx: SyncContext, stored: StoredQuery): Promise<number> {
  const nowMs = ctx.now();
  if (stored.status === 'ready' || stored.status === 'failed') return clampRetry(0);
  const since = Date.parse(stored.startedAt);
  return retryAfter(
    ctx.redis,
    ctx.keys,
    { kind: 'query', queryId: stored.queryId },
    {
      concurrency: ctx.settings.concurrency,
      nowMs,
      ...(stored.status === 'running' && !Number.isNaN(since) ? { runningSinceMs: since } : {}),
    },
  );
}

/** QueryResponse for a stored query (rows for summary, result for the other views). */
export async function toQueryResponse(
  ctx: SyncContext,
  stored: StoredQuery,
): Promise<QueryResponse> {
  const base = {
    query_id: stored.queryId,
    status: queryStatus(stored),
    retry_after: await queryRetryAfter(ctx, stored),
    computed_at: stored.computedAt || null,
  };
  const ready = stored.status === 'ready' ? stored.result : null;
  const { request } = stored;
  if (request.view === 'summary') {
    const summary = ready as SummaryResult | null;
    return {
      ...base,
      view: 'summary',
      rows: summary?.rows ?? [],
      dimension: summary?.dimension ?? request.dimension ?? null,
      cap_outliers: summary?.cap_outliers ?? request.cap_outliers ?? false,
      quality: summary?.quality ?? null,
    };
  }
  return { ...base, view: request.view, result: ready } as QueryResponse;
}

export async function postQuery(
  ctx: SyncContext,
  experimentId: number,
  raw: unknown,
): Promise<PostQueryResult> {
  const projectGuess = asObject(raw, new SyncApiError('unknown_view', 400, 'body')).project_id;
  if (typeof projectGuess === 'number' && Number.isSafeInteger(projectGuess)) {
    await enforceRate(ctx, projectGuess);
  }
  const request = await validateQuery(ctx, experimentId, raw);
  const id = queryId(experimentId, request);
  const stored = await readQuery(ctx, id);
  const existing = stored !== null && stored !== 'expired' ? stored : null;

  if (existing?.status === 'ready' && !request.refresh) {
    return { httpStatus: 200, body: await toQueryResponse(ctx, existing) };
  }
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return {
      httpStatus: 202,
      body: {
        query_id: id,
        status: existing.status,
        retry_after: await queryRetryAfter(ctx, existing),
      },
    };
  }
  const pending = await ctx.redis.zcard(ctx.keys.queryPending(request.project_id));
  if (pending >= MAX_PENDING_QUERIES) throw new SyncApiError('too_many_queries', 429);

  await submitQuery(ctx, experimentId, request);
  const queued = await readQuery(ctx, id);
  const retry = queued && queued !== 'expired' ? await queryRetryAfter(ctx, queued) : clampRetry(0);
  return { httpStatus: 202, body: { query_id: id, status: 'queued', retry_after: retry } };
}

export async function getQuery(
  ctx: SyncContext,
  projectId: number,
  experimentId: number,
  id: string,
): Promise<QueryResponse> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new SyncApiError('query_not_found', 404);
  const stored = await readQuery(ctx, id);
  if (stored === 'expired') throw new SyncApiError('expired', 410);
  if (stored === null || stored.experimentId !== experimentId || stored.projectId !== projectId) {
    await requireOwned(ctx, projectId, experimentId);
    throw new SyncApiError('query_not_found', 404);
  }
  return toQueryResponse(ctx, stored);
}
