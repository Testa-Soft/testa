/**
 * `POST /api/v1/stats` (PRD-006 §4.5, task 5.11), mounted at `/api/v1/stats`
 * behind the `X-Service-Token` middleware. P0 stub: 501
 * `{ "error": "not_implemented" }`; P3 replaces the handler in this file and
 * keeps `makeStatsRouter`'s signature.
 */
import { Hono } from 'hono';
import { notImplemented } from '../analytics/errors.ts';
import { serviceToken } from '../auth/service-token.ts';

export interface StatsRouterDeps {
  serviceToken: string;
}

export function makeStatsRouter(deps: StatsRouterDeps): Hono {
  const router = new Hono();
  router.use('*', serviceToken(deps.serviceToken));
  router.post('/', (c) => {
    const stub = notImplemented('stats');
    return c.json(stub.toBody(), stub.status);
  });
  return router;
}
