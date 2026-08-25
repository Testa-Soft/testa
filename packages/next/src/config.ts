/**
 * Project-config resolution for the middleware.
 *
 * Config CREATION lives in crobot for the MVP; `@testa/next` only *consumes* it.
 * So the source is pluggable behind one interface, chosen per deployment:
 *
 *   - `config`      — a static `ProjectConfig` object. Zero-latency, no network.
 *                     Ideal for local dev, the demo, and simple deploys.
 *   - `loadConfig`  — an async resolver the customer supplies (e.g. read Vercel
 *                     Edge Config, hit crobot). We cache its result by TTL.
 *   - `configUrl`   — fetch a `ProjectConfig` JSON (crobot/CDN). Cached by TTL;
 *                     `config_hash` is used to avoid re-parsing unchanged bodies.
 *
 * The CDN "immutable {hash}.json + mutable pointer" scheme in the PRD is a future
 * refinement of the `configUrl` adapter; the interface below already
 * accommodates it without changing callers.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';

export interface ConfigSource {
  config?: ProjectConfig;
  loadConfig?: (slug: string) => Promise<ProjectConfig | null> | ProjectConfig | null;
  configUrl?: string;
  /**
   * Server-side config caching.
   * - `true` (default): fresh for 60s, then served stale while revalidating in
   *   the background, never older than 5 min.
   * - `'per-pageload'`: DOCUMENT requests always fetch fresh (no cache between
   *   hard reloads — a publish is live on the very next pageview); soft-nav
   *   RSC/prefetch requests reuse the last fetched copy, so the config stays
   *   pinned during an SPA session.
   *
   * There is deliberately no "off" value: it would add a BLOCKING config fetch
   * to every matched request (documents, soft navs, prefetches) with no
   * last-known-good fallback. For fresh-config testing use `'per-pageload'`.
   */
  cache?: true | 'per-pageload';
  /** Fresh window override (ms) when caching is on. Default 60s. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  config: ProjectConfig | null;
  fetchedAtMs: number;
}

// Cache windows (when `cache` is on). The cache is SHARED across all visitors
// of a server instance (the config is project data, not per-user); a request
// only BLOCKS on a fetch when the instance is cold or the entry has aged past
// the max-stale bound. Between the two windows the stale config is served
// instantly and refreshed in the background, so a crobot publish propagates
// within ~one fresh window at zero added request latency.
const DEFAULT_TTL_MS = 60_000;
// How old a cached config may be and still be SERVED (refreshing behind it).
// Wide on purpose: nothing blocks on the network any more, so this bound is
// only choosing between "serve last-known-good" and "defer to the client".
// Serving is better while it is plausibly current, and 15 minutes is far
// beyond any healthy refresh interval — reaching it means refreshes are
// failing, at which point deferring to the client (which fetches for itself)
// is the right call.
const MAX_STALE_MS = 900_000;

export type ConfigCacheMode = 'swr' | 'per-pageload';

export class ConfigClient {
  private readonly source: ConfigSource;
  private readonly mode: ConfigCacheMode;
  private readonly ttlMs: number;
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<void>>();

  constructor(source: ConfigSource) {
    this.source = source;
    const cache = source.cache ?? true;
    if ((cache as unknown) === false) {
      throw new Error(
        'ConfigClient: `cache: false` was removed — it added a blocking config ' +
          'fetch to every matched request with no last-known fallback. Use ' +
          "`cache: 'per-pageload'` for always-fresh document loads.",
      );
    }
    this.mode = cache === true ? 'swr' : 'per-pageload';
    this.ttlMs = source.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Resolve the config for a slug. `nowMs` is injectable for tests (the caller
   * passes a monotonic clock; the middleware passes Date.now()). `waitUntil`
   * (the fetch event's, when the host provides one) keeps a background refresh
   * alive past the response; without it the refresh is fire-and-forget.
   */
  async get(
    slug: string,
    nowMs: number,
    waitUntil?: (promise: Promise<unknown>) => void,
    /** True when this request is a full document load (not an RSC soft nav). */
    isDocumentRequest = true,
  ): Promise<ProjectConfig | null> {
    // Static config short-circuits — always fresh, never cached/fetched.
    if (this.source.config) return this.source.config;

    if (this.mode === 'per-pageload') {
      if (isDocumentRequest) {
        // Hard reload: ALWAYS fetch fresh; store for the soft navs that follow.
        const config = await this.resolve(slug);
        if (config) this.cache.set(slug, { config, fetchedAtMs: nowMs });
        return config ?? this.cache.get(slug)?.config ?? null; // fail open to last-known
      }
      // Soft nav / prefetch: reuse the copy the last hard load fetched.
      const pinned = this.cache.get(slug);
      if (pinned) return pinned.config;
      const config = await this.resolve(slug); // cold instance mid-session
      this.cache.set(slug, { config, fetchedAtMs: nowMs });
      return config;
    }

    // SWR mode NEVER blocks a request on the network. A cold (or too-stale)
    // instance returns null and the proxy passes the request through
    // unexperimented; the client engine — which fetches its own config — then
    // owns the decision for that pageview, redirect included, behind the
    // anti-flicker shield. Meanwhile a background refresh warms this instance
    // so the NEXT request gets the flicker-free server-side path.
    //
    // Why not block for ~50ms instead: on serverless the isolate that would
    // pay it is often the same one that gets torn down straight after, so the
    // cost recurs per visitor rather than being amortised. Deferring keeps
    // TTFB flat and constant, and the fallback is a real experiment rather
    // than an unexperimented pageview.
    const cached = this.cache.get(slug);
    const age = cached ? nowMs - cached.fetchedAtMs : Number.POSITIVE_INFINITY;

    if (cached && age < this.ttlMs) return cached.config;

    // Anything not fresh triggers a deduped background refresh, kept alive past
    // the response by `waitUntil` where the host provides one.
    const refresh = this.refresh(slug, nowMs);
    if (refresh && waitUntil) waitUntil(refresh);

    // Stale but within the bound: last-known-good beats deferring — the visitor
    // still gets a server-side decision, and assignment is cookie-pinned so a
    // slightly old config cannot move anyone between variations.
    if (cached && age < MAX_STALE_MS) return cached.config;

    // Cold, or older than the bound: defer to the client for this request.
    return null;
  }

  /** Kick (or join) the background refresh for a slug. Never throws. */
  private refresh(slug: string, nowMs: number): Promise<void> | null {
    if (this.inflight.has(slug)) return null;
    const task = this.resolve(slug)
      .then((config) => {
        // A failed/empty refresh keeps the stale entry — fail open, never
        // downgrade a working config to null because one poll failed.
        if (config) this.cache.set(slug, { config, fetchedAtMs: nowMs });
      })
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(slug);
      });
    this.inflight.set(slug, task);
    return task;
  }

  private async resolve(slug: string): Promise<ProjectConfig | null> {
    if (this.source.loadConfig) {
      return (await this.source.loadConfig(slug)) ?? null;
    }
    if (this.source.configUrl) {
      return fetchConfig(this.source.configUrl);
    }
    return null;
  }
}

async function fetchConfig(url: string): Promise<ProjectConfig | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as ProjectConfig;
  } catch {
    // Never let a config-fetch failure break the request — fail open (no experiment).
    return null;
  }
}
