/**
 * Middleware composition helpers.
 *
 * Next.js runs ONE middleware and carries request-header overrides ON the
 * response via internal headers (`x-middleware-override-headers` + one
 * `x-middleware-request-<name>` per header). The override set is applied
 * WHOLESALE — the downstream request's headers are replaced with exactly that
 * list — so two independently-built responses can never be merged naively.
 *
 * These helpers make both composition directions safe without customers ever
 * touching the internal encoding:
 * - INNER (`Bproxy` inside testa): the `handler` option on `createTestaProxy`
 *   uses `toNextResponse` + `applyRequestHeaders` to merge the handler's
 *   response with testa's shield header and cookies.
 * - OUTER (`Aproxy` around testa): customer middleware that calls the testa
 *   proxy uses the exported `applyRequestHeaders(res, headers, req)` to add
 *   its own request-header overrides on top of testa's response.
 */

import { NextResponse } from 'next/server.js';

const OVERRIDE_LIST_HEADER = 'x-middleware-override-headers';
const OVERRIDE_VALUE_PREFIX = 'x-middleware-request-';

/** Minimal request shape needed to seed a wholesale override set. */
interface HasHeaders {
  headers: Headers;
}

/**
 * Add request-header overrides to a middleware response WITHOUT dropping the
 * overrides (or original request headers) it already carries.
 *
 * - If `res` already has an override set, the new headers are appended to it.
 * - If it has none, the full set is seeded from `req.headers` first (override
 *   semantics are wholesale — seeding only the new headers would DELETE every
 *   other request header downstream). `req` is required in that case.
 * - Redirect responses are returned unchanged: nothing downstream renders, so
 *   request-header overrides are meaningless on them.
 *
 * Returns the same response instance for chaining.
 */
export function applyRequestHeaders(
  res: NextResponse,
  headers: Record<string, string>,
  req?: HasHeaders,
): NextResponse {
  if (isRedirect(res)) return res;

  const existing = res.headers.get(OVERRIDE_LIST_HEADER);
  const names = new Set(existing ? existing.split(',').filter(Boolean) : []);

  if (!existing) {
    if (!req) {
      throw new Error(
        'applyRequestHeaders: the response carries no request-header overrides, ' +
          'so a full set must be seeded from the original request — pass `req` ' +
          'as the third argument (otherwise every other request header would be ' +
          'dropped downstream).',
      );
    }
    for (const [name, value] of req.headers) {
      res.headers.set(OVERRIDE_VALUE_PREFIX + name, value);
      names.add(name);
    }
  }

  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    res.headers.set(OVERRIDE_VALUE_PREFIX + key, value);
    names.add(key);
  }

  res.headers.set(OVERRIDE_LIST_HEADER, [...names].join(','));
  return res;
}

/** A 3xx response with a Location — the request never reaches the app. */
export function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400 && res.headers.has('location');
}

/**
 * Normalize a customer handler's return value to a `NextResponse` so testa can
 * merge cookies onto it. `null`/`undefined` mean "continue" (standard Next
 * middleware semantics); a plain `Response` is upgraded preserving status,
 * headers, and body.
 */
export function toNextResponse(
  out: Response | null | undefined,
  fallback: () => NextResponse,
): NextResponse {
  if (out == null) return fallback();
  if (out instanceof NextResponse) return out;
  return new NextResponse(out.body, out);
}
