/**
 * Pages Router client-navigation data requests (`/_next/data/…json`).
 *
 * These DO reach the proxy, and that matters more than it looks: on a Pages
 * Router site a soft navigation is the only signal the server gets, so this is
 * where a visitor who wasn't bucketed yet — someone entering a funnel by
 * clicking rather than by landing on it — gets their assignment and their
 * split-URL redirect. Next normalizes `req.url` to the PAGE url before
 * middleware sees it (`/_next/data/<buildId>/question/male/1.json` arrives as
 * `/question/male/1`), so no special handling is needed to decide them.
 *
 * What does need handling is the query string. Next appends the route's
 * interpolated params to a data request:
 *
 *   /_next/data/<id>/question/male/1.json?flow=7247&gender=male&step=1
 *                                         └ real ─┘ └ Next's own ──┘
 *
 * Merge those into a redirect's `Location` and they land in the visitor's
 * address bar — `/question/female/1?flow=7247&gender=male&step=1` — where they
 * are wrong twice over: they were never in the URL the visitor was on, and
 * `gender=male` now contradicts the page they were sent to.
 *
 * No header names them (only `x-nextjs-data: 1` marks the request), so they are
 * identified by shape: a param whose VALUE is one of the path's own segments is
 * Next's interpolation of that segment. A real param that happens to equal a
 * path segment is dropped too — it stays in the page's own query on the client,
 * it just doesn't ride along to the redirect destination.
 */

/** True when this is a Pages Router client-navigation data fetch. */
export function isPagesDataRequest(headers: Headers): boolean {
  return headers.get('x-nextjs-data') === '1';
}

/**
 * The same URL without the params Next interpolated from the route. Returns the
 * input untouched when there is nothing to strip.
 */
export function stripInterpolatedParams(url: URL): URL {
  const path = url.pathname.replace(/^\/+/, '');
  const segments = new Set(path.split('/').filter(Boolean).map(decodeSafe));
  // A catch-all route (`[...slug]`) interpolates the whole remainder as one
  // value, so the joined path counts as a segment too.
  segments.add(decodeSafe(path));

  const keep = [...url.searchParams].filter(([, value]) => !segments.has(value));
  if (keep.length === url.searchParams.size) return url;

  const cleaned = new URL(url.href);
  cleaned.search = '';
  for (const [key, value] of keep) cleaned.searchParams.append(key, value);
  return cleaned;
}

/** `decodeURIComponent` that never throws on a malformed escape. */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
