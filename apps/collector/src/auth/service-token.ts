/**
 * `X-Service-Token` middleware for the service-to-service APIs (sync API,
 * stats). Crobot sends the shared `SERVICE_TOKEN`; anything else is a 401
 * `{ "error": "unauthorized" }`. Compared in constant time.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const SERVICE_TOKEN_HEADER = 'X-Service-Token';

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function serviceToken(expected: string): MiddlewareHandler {
  if (expected.length === 0) throw new Error('serviceToken: empty token');
  return async (c, next) => {
    if (!tokenMatches(c.req.header(SERVICE_TOKEN_HEADER), expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
