/**
 * Project-config resolution for the client SDK.
 *
 * A pure SPA has one project, so this is simpler than the middleware's
 * multi-slug `ConfigClient`: it resolves EITHER an inline `config` (zero-latency,
 * no network — ideal for Lovable exports that ship their config) OR fetches
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
