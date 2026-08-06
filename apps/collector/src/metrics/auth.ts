/**
 * `X-Service-Token` middleware for the read API.
 *
 * The token is compared in constant time so an attacker cannot exploit
 * timing differences to guess the secret character-by-character.
 * Token is read from `config.metrics.serviceToken` (env METRICS_SERVICE_TOKEN).
 */

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.ts';

const encoder = new TextEncoder();

function constantTimeCompare(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const requireServiceToken: MiddlewareHandler = async (c, next) => {
  const token = c.req.header('x-service-token');
  if (!token || !constantTimeCompare(token, config.metrics.serviceToken)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};
