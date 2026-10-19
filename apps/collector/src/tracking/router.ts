/**
 * Tracking API (admin v2), mounted at `/api/v1/projects`, Bearer auth exactly
 * like the config write API (`Authorization: Bearer <CONFIG_WRITE_TOKEN>`):
 *
 *   GET /:projectId/tracking/events?events=a,b             → TrackingEventsResponse
 *   GET /:projectId/tracking/hits?event=&since=&limit=     → TrackingHitsResponse
 *
 * `projectId` is the numeric project id the events carry. Errors:
 * 401 `{ error: 'unauthorized' }`, 400 `{ error: 'invalid_param', field }`,
 * 500 `{ error: 'internal_error' }` (logged).
 */
import { Hono } from 'hono';
import type { QueryRunner } from '../analytics/attribution.ts';
import { isBearerAuthorized } from '../auth/bearer.ts';
import { query } from '../db/clickhouse.ts';
import { fetchTrackingEvents } from './events.ts';
import { fetchTrackingHits } from './hits.ts';
import { TrackingParamError, parseEventList, parseHitsParams, parseProjectId } from './params.ts';

export interface TrackingRouterDeps {
  /** Same secret as the config write API. */
  token: string;
  query?: QueryRunner;
  now?: () => number;
}

export function makeTrackingRouter(deps: TrackingRouterDeps): Hono {
  const run: QueryRunner = deps.query ?? ((sql, params) => query(sql, params));
  const now = deps.now ?? Date.now;
  const router = new Hono();

  router.use('*', async (c, next) => {
    if (!isBearerAuthorized(c.req.header('authorization'), deps.token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
    return undefined;
  });

  router.onError((err, c) => {
    if (err instanceof TrackingParamError) {
      return c.json({ error: 'invalid_param', field: err.field }, 400);
    }
    console.error('[tracking] unhandled error', { path: c.req.path, err: (err as Error).message });
    return c.json({ error: 'internal_error' }, 500);
  });

  router.get('/:projectId/tracking/events', async (c) => {
    const projectId = parseProjectId(c.req.param('projectId'));
    const names = parseEventList(c.req.query('events'));
    c.header('Cache-Control', 'no-store');
    return c.json(await fetchTrackingEvents(run, projectId, names, now()));
  });

  router.get('/:projectId/tracking/hits', async (c) => {
    const projectId = parseProjectId(c.req.param('projectId'));
    const params = parseHitsParams(
      { event: c.req.query('event'), since: c.req.query('since'), limit: c.req.query('limit') },
      now(),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(await fetchTrackingHits(run, projectId, params));
  });

  return router;
}
