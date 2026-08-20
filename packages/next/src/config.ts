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
   * Server-side config caching. Default `true`: fresh for 60s, then served
   * stale while revalidating in the background, never older than 5 min.
   * `false`: NO server-side cache — every request fetches the config
   * (adds the fetch's latency to every matched request; use for
   * fast-iteration testing, not steady-state production).
   */
  cache?: boolean;
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
const MAX_STALE_MS = 300_000;

export class ConfigClient {
  private readonly source: ConfigSource;
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<void>>();

  constructor(source: ConfigSource) {
    this.source = source;
    this.enabled = source.cache ?? true;
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
  ): Promise<ProjectConfig | null> {
    // Static config short-circuits — always fresh, never cached/fetched.
    if (this.source.config) return this.source.config;

    // Caching disabled: fetch fresh on every request, store nothing.
    if (!this.enabled) return this.resolve(slug);

    const cached = this.cache.get(slug);
    if (cached) {
      const age = nowMs - cached.fetchedAtMs;
      if (age < this.ttlMs) return cached.config;
      if (age < MAX_STALE_MS) {
        // Stale but bounded: serve it NOW, refresh in the background (deduped).
        const refresh = this.refresh(slug, nowMs);
        if (refresh && waitUntil) waitUntil(refresh);
        return cached.config;
      }
      // Older than the max-stale bound: too old to serve — block on a refetch
      // (joining an inflight refresh when one is already running).
      const inflight = this.inflight.get(slug);
      if (inflight) {
        await inflight;
        return this.cache.get(slug)?.config ?? null;
      }
    }

    // Cold (or max-stale) instance: the paths that block on the network.
    const config = await this.resolve(slug);
    this.cache.set(slug, { config, fetchedAtMs: nowMs });
    return config;
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
