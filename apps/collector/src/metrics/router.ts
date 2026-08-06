/**
 * Read-API router — mounted at `/api/v1/metrics` in index.ts.
 *
 * All routes require `X-Service-Token` (see auth.ts). Query params are
 * validated by params.ts first; metric computation will be added in 4.3–4.7.
 * Until those tasks land, every endpoint returns 501.
 */

import { Hono } from 'hono';
import { requireServiceToken } from './auth.ts';
import { parseMetricRequest } from './params.ts';

export const metricsRouter = new Hono();

metricsRouter.use('*', requireServiceToken);

const NOT_IMPLEMENTED = { error: 'not_implemented' } as const;

function stub(path: string): void {
  metricsRouter.get(path, (c) => {
    const result = parseMetricRequest(c.req.query());
    if (!result.ok) {
      return c.json({ error: result.error, field: result.field }, 400);
    }
    return c.json(NOT_IMPLEMENTED, 501);
  });
}

stub('/aov');
stub('/rpv');
stub('/sessions');
stub('/funnel');
