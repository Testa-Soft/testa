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
const DEFAULT_TTL_MS = 60_000;

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

  const url = resolveConfigUrl(source);
  if (!url) return Promise.resolve(null);

  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = source.cacheTtlMs ?? DEFAULT_TTL_MS;

  const existing = preloadCache.get(url);
  if (existing && (existing.settledAtMs === null || now() - existing.settledAtMs < ttlMs)) {
    // Reuse an in-flight request, or a settled one still within its TTL.
    return existing.promise;
  }

  // `fetchConfig` never rejects (it fails open to null), so `settledAtMs` is
  // always stamped — the null result ages out by TTL rather than poisoning.
  const entry: PreloadEntry = { promise: Promise.resolve(null), settledAtMs: null };
  entry.promise = fetchConfig(url, fetchImpl).then((config) => {
    entry.settledAtMs = now();
    return config;
  });
  preloadCache.set(url, entry);
  return entry.promise;
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

async function fetchConfig(url: string, fetchImpl: typeof fetch): Promise<ProjectConfig | null> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as ProjectConfig;
  } catch {
    // Never let a config-fetch failure break the app — fail open (no experiment).
    return null;
  }
}
