/**
 * Sync API (PRD-006 Part 3, §5.5), mounted at `/api/v1/experiments` behind the
 * `X-Service-Token` middleware. P0 stub: every route answers 501
 * `{ "error": "not_implemented" }`; P4 (task 5.8) replaces the handlers in
 * this file and keeps `makeSyncRouter`'s signature.
 *
 *   PUT    /:experimentId/subscription
 *   DELETE /:experimentId/subscription
 *   GET    /:experimentId/daily-summary[?since_run_id=]
 *   POST   /:experimentId/queries
 *   GET    /:experimentId/queries/:queryId
 */
import { type Context, Hono } from 'hono';
import { notImplemented } from '../analytics/errors.ts';
import { serviceToken } from '../auth/service-token.ts';

export interface SyncRouterDeps {
  serviceToken: string;
}

export function makeSyncRouter(deps: SyncRouterDeps): Hono {
  const router = new Hono();
  router.use('*', serviceToken(deps.serviceToken));

  const notYet = (c: Context) => {
    const stub = notImplemented('sync');
    return c.json(stub.toBody(), stub.status);
  };

  router.put('/:experimentId/subscription', notYet);
  router.delete('/:experimentId/subscription', notYet);
  router.get('/:experimentId/daily-summary', notYet);
  router.post('/:experimentId/queries', notYet);
  router.get('/:experimentId/queries/:queryId', notYet);
  return router;
}
