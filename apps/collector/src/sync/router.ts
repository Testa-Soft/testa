/**
 * Sync API (PRD-006 Part 3, §5.5), mounted at `/api/v1/experiments` behind the
 * `X-Service-Token` middleware. Reads never compute: they only read
 * `metric_subscriptions`, `metric_daily` and the modeler's Redis state.
 *
 *   PUT    /:experimentId/subscription                 (body project_id) → 200 {status, next_run_at}
 *   DELETE /:experimentId/subscription?project_id=                       → 200 {status, next_run_at: null}
 *   GET    /:experimentId/daily-summary?project_id=[&since_run_id=]      → 200 DailySummaryResponse
 *   POST   /:experimentId/queries                      (body project_id) → 200 QueryResponse (cached) | 202 QueryAccepted
 *   GET    /:experimentId/queries/:queryId?project_id=                   → 200 QueryResponse | 404 | 410
 * Experiment ids are unique per project only (R3): `project_id` is required
 * everywhere (400 `invalid_body` field `project_id`); a project that doesn't
 * own the experiment → 404 `experiment_not_found`.
 * Errors: `{ "error": code, "field"? }` with the §5.5 status codes.
 */
import { type Context, Hono } from 'hono';
import { SyncApiError } from '../analytics/errors.ts';
import { serviceToken } from '../auth/service-token.ts';
import { type SyncContext, defaultSyncContext } from './context.ts';
import { getDailySummary } from './daily-summary.ts';
import { getQuery, postQuery } from './queries.ts';
import { deleteSubscription, putSubscription } from './subscription.ts';
import { parseId, parseProjectId } from './validate.ts';

export interface SyncRouterDeps {
  serviceToken: string;
  /** Defaults to the env-configured context (shared Redis / ClickHouse / config store). */
  context?: () => SyncContext;
}

const notSubscribed = new SyncApiError('not_subscribed', 404);
const notFound = new SyncApiError('experiment_not_found', 404);

async function jsonBody(c: Context, onError: SyncApiError): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw onError;
  }
}

function withRetryAfter<T extends { retry_after: number }>(
  c: Context,
  body: T,
  status: 200 | 202 = 200,
) {
  c.header('Retry-After', String(body.retry_after));
  return c.json(body, status);
}

export function makeSyncRouter(deps: SyncRouterDeps): Hono {
  const router = new Hono();
  const ctx = deps.context ?? defaultSyncContext;
  router.use('*', serviceToken(deps.serviceToken));

  router.onError((err, c) => {
    if (err instanceof SyncApiError) return c.json(err.toBody(), err.status);
    console.error('[sync] unhandled error', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  router.put('/:experimentId/subscription', async (c) => {
    const id = parseId(c.req.param('experimentId'), notFound);
    const body = await jsonBody(c, new SyncApiError('invalid_status', 400, 'body'));
    return c.json(await putSubscription(ctx(), id, body), 200);
  });

  router.delete('/:experimentId/subscription', async (c) => {
    const id = parseId(c.req.param('experimentId'), notSubscribed);
    const projectId = parseProjectId(c.req.query('project_id'));
    return c.json(await deleteSubscription(ctx(), projectId, id), 200);
  });

  router.get('/:experimentId/daily-summary', async (c) => {
    const id = parseId(c.req.param('experimentId'), notSubscribed);
    const projectId = parseProjectId(c.req.query('project_id'));
    const since = c.req.query('since_run_id');
    return withRetryAfter(c, await getDailySummary(ctx(), projectId, id, since || undefined));
  });

  router.post('/:experimentId/queries', async (c) => {
    const id = parseId(c.req.param('experimentId'), notFound);
    const body = await jsonBody(c, new SyncApiError('unknown_view', 400, 'body'));
    const result = await postQuery(ctx(), id, body);
    return withRetryAfter(c, result.body, result.httpStatus);
  });

  router.get('/:experimentId/queries/:queryId', async (c) => {
    const id = parseId(c.req.param('experimentId'), new SyncApiError('query_not_found', 404));
    const projectId = parseProjectId(c.req.query('project_id'));
    return withRetryAfter(c, await getQuery(ctx(), projectId, id, c.req.param('queryId')));
  });

  return router;
}
