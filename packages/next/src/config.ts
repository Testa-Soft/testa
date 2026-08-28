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
   * - `true` (default): the cached copy is served on every request and
   *   revalidated behind the response, up to 30 min old.
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
  /**
   * Minimum gap between background revalidations (ms). Default 0 — revalidate
   * on every request. Not a freshness window: the cached copy is served either
   * way. Raise it only to throttle a config origin that cannot take the load.
   */
  cacheTtlMs?: number;
  /**
   * Cold-instance policy — set by `decisions: 'server'` on the proxy.
   * When true, a cold instance AWAITS the config (capped by `fetchTimeoutMs`)
   * so the decision is made server-side even on the first request. When false
   * (default) a cold instance resolves null and the caller defers to the
   * client. See `ProxyDecisionMode`.
   */
  blockOnCold?: boolean;
  /**
   * Latency budget (ms) for the one fetch that can sit on the request path —
   * the cold fetch under `decisions: 'server'`. On expiry the request proceeds
   * without a config (fail open) rather than stalling. Default 400ms: the
   * CDN-cached config answers in ~50-100ms, and a request that would take
   * longer forfeits its server-side decision instead of making the visitor
   * wait. Ignored in the other modes, which never block.
   */
  fetchTimeoutMs?: number;
}

interface CacheEntry {
  config: ProjectConfig | null;
  fetchedAtMs: number;
}

// The cache is SHARED across all visitors of a server instance (the config is
// project data, not per-user). Nothing blocks on the network except a cold
// instance under `decisions: 'server'`; every other request is answered from
// memory and revalidated behind the response, so a crobot publish propagates
// within about one round trip at zero added request latency.
// MINIMUM gap between background revalidations, not a freshness window — the
// cached copy is always served, whatever its age (up to `MAX_STALE_MS`).
// Zero means revalidate on every request; the in-flight dedupe keeps that to
// one open fetch per project per instance regardless of traffic. Raise it only
// to deliberately throttle a config origin that cannot take the load.
const DEFAULT_TTL_MS = 0;
// How old a cached config may be and still be SERVED (refreshing behind it).
// Wide on purpose: nothing blocks on the network any more, so this bound is
// only choosing between "serve last-known-good" and "defer to the client".
// Serving is better while it is plausibly current.
//
// 30 minutes, sized to a visitor's session rather than to a refresh interval.
// An instance that has served this project at any point in the last half hour
// keeps answering from memory, so a visitor mid-session never meets a cold one
// — only the genuinely first request an instance ever serves can be cold, which
// is the one case that has to be. Widening it costs nothing in freshness: every
// request already triggers a background refresh, so a
// publish still lands within about a round trip. It only changes what an
// instance does after a long idle — serve the last known good copy and refresh behind
// it, rather than defer to the client.
const MAX_STALE_MS = 1_800_000;
/** Default budget for the one fetch that can block a request (`decisions: 'server'`). */
const FETCH_TIMEOUT_MS = 400;

export type ConfigCacheMode = 'swr' | 'per-pageload';

export class ConfigClient {
  private readonly source: ConfigSource;
  private readonly mode: ConfigCacheMode;
  private readonly ttlMs: number;
  private readonly blockOnCold: boolean;
  private readonly fetchTimeoutMs: number;
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
    this.blockOnCold = source.blockOnCold ?? false;
    this.fetchTimeoutMs = source.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
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

    // `decisions: 'server'` — the caller wants the decision made server-side
    // even on a cold instance, and accepts the latency. Bounded by
    // `fetchTimeoutMs` so a slow config origin can never stall a request
    // indefinitely; on expiry `resolve` yields null and we fail open below.
    if (!cached && this.blockOnCold) {
      const inflight = this.inflight.get(slug);
      if (inflight) {
        await inflight;
        return this.cache.get(slug)?.config ?? null;
      }
      // The budget is applied HERE, not only inside the fetch, so it also caps
      // a custom `loadConfig` (Edge Config, KV, a customer's own resolver) —
      // any of which can hang. A late result still populates the cache for the
      // next request; this request just stops waiting for it.
      const config = await withBudget(this.resolve(slug), this.fetchTimeoutMs);
      if (config) this.cache.set(slug, { config, fetchedAtMs: nowMs });
      return config;
    }

    // EVERY request refreshes, behind the response. `refresh` is deduped on an
    // in-flight map, so this does not scale with traffic: an instance has at
    // most one fetch open per project at a time, and the rate is bounded by the
    // round trip, not by request volume. Under load that means back-to-back
    // revalidations — which is the point, since the alternative is serving a
    // config up to `cacheTtlMs` old for no gain. Nearly all of them are 304s
    // against the CDN. `cacheTtlMs` still throttles when set above 0.
    if (age >= this.ttlMs) {
      const refresh = this.refresh(slug, nowMs);
      if (refresh && waitUntil) waitUntil(refresh);
    }

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
      return fetchConfig(this.source.configUrl, this.source.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
    }
    return null;
  }
}

/**
 * Resolve `task`, or null once `timeoutMs` elapses — whichever lands first.
 * The task is never cancelled, only stopped being waited on: its result still
 * reaches the cache via `resolve`'s caller, so the wait is not wasted.
 */
function withBudget<T>(task: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void task
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

async function fetchConfig(url: string, timeoutMs: number): Promise<ProjectConfig | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      // A slow origin (not a dead one — dead fails fast) would otherwise stall
      // whatever awaited this for as long as the platform allows.
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as ProjectConfig;
  } catch {
    // Timeout, network failure, malformed JSON — fail open (no experiment).
    return null;
  }
}
