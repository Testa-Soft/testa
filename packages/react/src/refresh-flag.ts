/**
 * `?testa_refresh=1` — force this page load to fetch a fresh config.
 *
 * The config is cached in three places, each of which can hide a just-published
 * change for up to its window: the browser's HTTP cache (`max-age`), the
 * module-level preload cache, and — for the life of an open tab — the config
 * object the provider captured on first render. That is the right default for
 * visitors, and exactly wrong when you are QAing a publish.
 *
 * With the flag present the preload cache is skipped and the fetch is issued
 * with `cache: 'reload'`, so the browser ignores its stored copy and goes to
 * the network. It deliberately does NOT append a cache-busting query
 * parameter: that would also bypass the CDN edge cache and put every such
 * request on the origin, which is a cheap denial-of-service vector for a
 * parameter anyone can add to a URL. A publish purges the edge cache, so
 * revalidating against it is enough to get the newest config.
 *
 * Note this refreshes the CONFIG only — it does not re-roll the visitor's
 * sticky `_testa_exp` assignment, which is what decides *which* variation they
 * see. Clear cookies (or use a fresh incognito window) to re-bucket.
 */

export const REFRESH_FLAG = 'testa_refresh';

/** True when a query string asks for a forced config refresh. */
export function isRefreshRequested(search: string): boolean {
  const value = new URLSearchParams(search).get(REFRESH_FLAG);
  return value === '1' || value === 'true';
}

/** Read the flag off the live URL. Always false outside a browser (SSR). */
export function isRefreshRequestedHere(): boolean {
  if (typeof window === 'undefined') return false;
  return isRefreshRequested(window.location.search);
}
