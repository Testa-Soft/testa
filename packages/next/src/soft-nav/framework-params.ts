/**
 * Framework-reserved query params — Next's own, never the visitor's.
 *
 * Context worth keeping: Pages Router `_next/data` requests (a soft navigation)
 * DO reach the proxy. Next normalizes `req.url` to the page URL before
 * middleware sees it, so `/_next/data/<buildId>/question/male/1.json` arrives as
 * `/question/male/1` and the `/_next` path filter never fires. That is
 * load-bearing: on a Pages Router site a soft nav is the only signal the server
 * gets, so it is where a visitor entering a funnel by clicking gets bucketed.
 *
 * Next adds params to the URLs it fetches during a client navigation, and every
 * one of them reaches middleware inside `req.nextUrl`:
 *
 *   App Router soft nav      /pricing?_rsc=8f2a1
 *   Pages Router data (old)  /pricing?__nextDataReq=1
 *   i18n / fallback plumbing /pricing?__nextLocale=en&__nextDefaultLocale=en
 *   early App Router         /pricing?__flight__=1
 *
 * Left in place they break experiments two ways, both silent:
 *
 *   MATCHING — `contains` and `regex` modes test the raw href, so a rule
 *   anchored at the end (`/pricing$`, the shape a dashboard produces) matches a
 *   hard load and fails on a soft nav. The experiment works when you type the
 *   URL and does nothing when you click a link.
 *
 *   DESTINATION — a redirect merges the request's query into `Location`, so
 *   `_rsc=8f2a1` follows the visitor to the variant and into their address bar.
 *
 * Stripping by NAME, never by value. That distinction is the whole design: a
 * reserved name is PROOF the param is Next's, so nothing the visitor typed can
 * be removed by mistake.
 *
 * The one thing this deliberately does NOT clean up is the route params Next
 * interpolates onto a data request (`/question/male/1` → `…?gender=male&step=1`).
 * They are indistinguishable from a visitor's own param that happens to equal a
 * path segment (`/blog/2024?year=2024`) — Next even OVERWRITES a colliding name
 * with the path value before we see it, so `?step=99` arrives as `?step=7`.
 * Removing them by shape would sometimes remove a param the visitor really has,
 * and carrying a stale `gender=male` into the address bar is the lesser fault:
 * cosmetic, and never lost data.
 */

/** Exact names Next owns. */
const RESERVED_NAMES = new Set(['_rsc']);
/** Prefixes Next owns — `__nextDataReq`, `__nextLocale`, `__flight_router_state_tree__`, … */
const RESERVED_PREFIXES = ['__next', '__flight'] as const;

function isReserved(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return true;
  return RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The same URL without Next's own params. Returns the input untouched when
 * there is nothing to strip, so the common case allocates nothing.
 */
export function stripFrameworkParams(url: URL): URL {
  const keep = [...url.searchParams].filter(([name]) => !isReserved(name));
  if (keep.length === url.searchParams.size) return url;

  const cleaned = new URL(url.href);
  cleaned.search = '';
  for (const [name, value] of keep) cleaned.searchParams.append(name, value);
  return cleaned;
}
