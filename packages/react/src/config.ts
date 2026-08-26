/**
 * Project-config resolution for the client SDK.
 *
 * A pure SPA has one project, so this is simpler than the middleware's
 * multi-slug `ConfigClient`: it resolves EITHER an inline `config` (zero-latency,
 * no network — ideal for apps that ship their config) OR fetches
 * `{host}/api/v1/config/{projectId}` once and caches it by TTL.
 *
 * A config-fetch failure fails open (returns null → no experiments run), never
 * throwing into the host app.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { CONFIG_PROMISE_KEY } from '@testa-soft/dom';
import { isRefreshRequestedHere } from './refresh-flag.ts';

/** Baked-in default config host; a client only needs to pass `projectId`. */
export const DEFAULT_CONFIG_HOST = 'https://config.testa-soft.tech';

export interface ClientConfigSource {
  /** A static `ProjectConfig`. Wins over `projectId` / `configUrl`. */
  config?: ProjectConfig;
  /** The project's id — config is fetched from `{host}/api/v1/config/{projectId}`. */
  projectId?: string;
  /** Config host. Default `DEFAULT_CONFIG_HOST`. */
  host?: string;
  /** Explicit config URL — overrides `host` + `projectId`. */
  configUrl?: string;
  /** Cache lifetime for a fetched config (ms). Default 30s. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  config: ProjectConfig | null;
  fetchedAtMs: number;
}

// Refetch window between config polls (client-side, served by the CDN).
// 30s rather than 60s so a publish surfaces within half a minute; the fetch
// revalidates (304s on the edge), so a shorter window costs almost nothing.
const DEFAULT_TTL_MS = 30_000;

export class ConfigClient {
  private readonly source: ClientConfigSource;
  private readonly ttlMs: number;
  private cache: CacheEntry | null = null;

  constructor(source: ClientConfigSource) {
    this.source = source;
    this.ttlMs = source.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Resolve the config. `nowMs` is injectable for tests; `fetchImpl` too. */
  async get(nowMs: number, fetchImpl: typeof fetch = fetch): Promise<ProjectConfig | null> {
    // Inline config short-circuits — always fresh, never fetched.
    if (this.source.config) return this.source.config;

    if (this.cache && nowMs - this.cache.fetchedAtMs < this.ttlMs) {
      return this.cache.config;
    }

    const url = resolveConfigUrl(this.source);
    const config = url ? await fetchConfig(url, fetchImpl) : null;
    this.cache = { config, fetchedAtMs: nowMs };
    return config;
  }
}

/**
 * Module-level preload cache — the mechanism behind fetching config during
 * FIRST RENDER (before paint, before effects) instead of inside a `useEffect`.
 *
 * `<TestaProvider/>` calls `preloadConfig` from a `useState` initializer so the
 * request is in flight before children even render. React StrictMode
 * double-invokes that initializer and remounts effects; keying the in-flight /
 * settled promise by the resolved config URL means all of that collapses onto
 * ONE network request.
 */
interface PreloadEntry {
  promise: Promise<ProjectConfig | null>;
  /** null while in-flight; the settle time (ms) once resolved — TTL runs from here. */
  settledAtMs: number | null;
}

const preloadCache = new Map<string, PreloadEntry>();

export interface PreloadOptions {
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
  /** Fetch impl, injectable for tests. Default global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Skip every cache (preload map + browser HTTP cache) for this call.
   * Defaults to whether `?testa_refresh=1` is on the current URL — read here,
   * once, so every caller sharing the preload cache agrees. See refresh-flag.ts.
   */
  force?: boolean;
}

/**
 * Resolve the config the same way `ConfigClient` does, but eagerly and deduped
 * across concurrent/repeated calls (StrictMode double-render, remounts):
 *
 *   - inline `config` → resolved immediately, no network, no cache;
 *   - otherwise fetch the resolved URL once and reuse the in-flight promise;
 *   - a settled entry is reused until `cacheTtlMs` (default 30s) elapses from
 *     its settle time, then the next call refetches.
 *
 * A failed fetch resolves `null` (fail open, never throws) and is cached only
 * for the TTL — it never permanently poisons the cache.
 */
export function preloadConfig(
  source: ClientConfigSource,
  opts: PreloadOptions = {},
): Promise<ProjectConfig | null> {
  // Inline config short-circuits — always fresh, never fetched or cached.
  if (source.config) return Promise.resolve(source.config);

  // No browser, no fetch. This is called from a `useState` initializer, i.e.
  // during RENDER — which happens on the server too, on every SSR pass in the
  // Pages Router and every client component in the App Router. Nothing can ever
  // consume the result there (effects don't run), so fetching would be a config
  // request the server pays for and discards. Hydration re-runs the initializer
  // in the browser, which is where the real fetch belongs.
  if (typeof document === 'undefined') return Promise.resolve(null);

  const url = resolveConfigUrl(source);
  if (!url) return Promise.resolve(null);

  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = source.cacheTtlMs ?? DEFAULT_TTL_MS;
  const force = opts.force ?? isRefreshRequestedHere();

  const existing = preloadCache.get(url);
  if (!force && existing && (existing.settledAtMs === null || now() - existing.settledAtMs < ttlMs)) {
    // Reuse an in-flight request, or a settled one still within its TTL.
    return existing.promise;
  }

  // Adopt the fetch the `<head>` snippet already started (buildConfigPreloadSnippet)
  // — it began during HTML parse, long before hydration could reach this code.
  // Taken only once, and never when forcing a refresh, so it can't serve a
  // stale body later in the page's life.
  if (!force) {
    const headStart = takeHeadStartedFetch();
    if (headStart) {
      const adopted: PreloadEntry = { promise: Promise.resolve(null), settledAtMs: null };
      adopted.promise = headStart.then((config) => {
        adopted.settledAtMs = now();
        // A failed head fetch resolves null; fall back to a normal fetch rather
        // than leaving the page unexperimented.
        return config ?? fetchConfig(url, fetchImpl);
      });
      preloadCache.set(url, adopted);
      return adopted.promise;
    }
  }

  // `fetchConfig` never rejects (it fails open to null), so `settledAtMs` is
  // always stamped — the null result ages out by TTL rather than poisoning.
  const entry: PreloadEntry = { promise: Promise.resolve(null), settledAtMs: null };
  entry.promise = fetchConfig(url, fetchImpl, force).then((config) => {
    entry.settledAtMs = now();
    return config;
  });
  preloadCache.set(url, entry);
  return entry.promise;
}

/**
 * Consume the promise the `<head>` preload snippet left on `window`, if any.
 * Removed as it is taken so exactly one caller adopts it — a second call
 * fetches normally rather than re-reading a body that may since have aged.
 */
function takeHeadStartedFetch(): Promise<ProjectConfig | null> | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as Record<string, unknown>;
  const pending = host[CONFIG_PROMISE_KEY];
  if (!pending || typeof (pending as Promise<unknown>).then !== 'function') return null;
  delete host[CONFIG_PROMISE_KEY];
  return pending as Promise<ProjectConfig | null>;
}

/** Clear the module-level preload cache. Test-only. */
export function __resetPreloadCacheForTests(): void {
  preloadCache.clear();
}

/** Build the config URL from the source, or null when nothing is resolvable. */
export function resolveConfigUrl(source: ClientConfigSource): string | null {
  if (source.configUrl) return source.configUrl;
  if (source.projectId) {
    const host = (source.host ?? DEFAULT_CONFIG_HOST).replace(/\/+$/, '');
    return `${host}/api/v1/config/${source.projectId}`;
  }
  return null;
}

async function fetchConfig(
  url: string,
  fetchImpl: typeof fetch,
  force = false,
): Promise<ProjectConfig | null> {
  try {
    const res = await fetchImpl(force ? bustCache(url) : url, {
      headers: { accept: 'application/json' },
      // `no-cache` does NOT skip the cache — it forces REVALIDATION: the
      // browser always asks, sending `If-None-Match` with the stored ETag, and
      // the CDN answers 304 (empty body, edge-served) when nothing changed.
      // Without this the default mode lets the browser serve its stored copy
      // for the whole `max-age` window without asking, which is what hid a
      // just-published config behind a stale one.
      //
      // Deliberately NOT a random query parameter on every request: that
      // defeats the CDN edge cache too, so every visitor's pageview becomes an
      // origin request to the collector — no rate limiting stands in front of
      // it, and the geo worker's own subrequest stops hitting the edge cache.
      // Revalidation gets the same freshness for ~200 bytes. The absolute
      // bypass is reserved for `?testa_refresh=1` (see refresh-flag.ts).
      cache: force ? 'reload' : 'no-cache',
    });
    if (!res.ok) return null;
    return (await res.json()) as ProjectConfig;
  } catch {
    // Never let a config-fetch failure break the app — fail open (no experiment).
    return null;
  }
}

/** Append a one-shot cache-buster — QA only, via `?testa_refresh=1`. */
function bustCache(url: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}_testa_t=${Date.now().toString(36)}`;
}
