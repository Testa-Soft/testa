/**
 * `POST /api/v1/stats` (PRD-006 §4.5, task 5.11), mounted at `/api/v1/stats`
 * behind the `X-Service-Token` middleware. Crobot sends summed daily rows; the
 * response is per metric, per variation `VariationStats`. 400
 * `{ error: 'invalid_body' | 'too_large', field? }` on bad input.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serviceToken } from '../auth/service-token.ts';
import { MAX_BODY_BYTES, type StatsError, parseStatsBody, runStats } from './route.ts';

export interface StatsRouterDeps {
  serviceToken: string;
}

export function makeStatsRouter(deps: StatsRouterDeps): Hono {
  const router = new Hono();
  router.use('*', serviceToken(deps.serviceToken));
  // Reject oversized bodies while streaming, before they are buffered.
  router.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'too_large' } satisfies StatsError, 400),
    }),
  );
  router.post('/', async (c) => {
    const parsed = parseStatsBody(await c.req.text());
    if (!parsed.ok) return c.json(parsed.error, 400);
    return c.json(runStats(parsed.body));
  });
  return router;
}
