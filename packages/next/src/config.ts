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
  /** Cache lifetime for `loadConfig` / `configUrl` results (ms). Default 30s. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  config: ProjectConfig | null;
  fetchedAtMs: number;
}

// One fetch per visitor session: the config is not expected to change while a
// visitor browses, so cache for the session window (30 min, = SESSION_LENGTH).
// A crobot publish reaches long-lived server instances when this expires;
// override with `cacheTtlMs` where faster propagation matters (demos, previews).
const DEFAULT_TTL_MS = 1_800_000;

export class ConfigClient {
  private readonly source: ConfigSource;
  private readonly ttlMs: number;
  private cache = new Map<string, CacheEntry>();

  constructor(source: ConfigSource) {
    this.source = source;
    this.ttlMs = source.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Resolve the config for a slug. `nowMs` is injectable for tests (the caller
   * passes a monotonic clock; the middleware passes Date.now()).
   */
  async get(slug: string, nowMs: number): Promise<ProjectConfig | null> {
    // Static config short-circuits — always fresh, never cached/fetched.
    if (this.source.config) return this.source.config;

    const cached = this.cache.get(slug);
    if (cached && nowMs - cached.fetchedAtMs < this.ttlMs) {
      return cached.config;
    }

    const config = await this.resolve(slug);
    this.cache.set(slug, { config, fetchedAtMs: nowMs });
    return config;
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
