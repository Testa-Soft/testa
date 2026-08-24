/**
 * Config resolution for `<TestaRouterGuard/>`'s zero-config mode.
 *
 * The guard needs a `ProjectConfig` to map a cookie assignment to a variant
 * URL. An inline `config` prop stays supported (fixtures, self-managed
 * config), but the clean integration is `projectId` — the guard then fetches
 * the same servable config the proxy uses, once per page load:
 *
 * - Module-level promise cache keyed by URL: StrictMode's double-mount,
 *   remounts, and multiple guards all share ONE request.
 * - Browser-side fetch of the CDN-cached config endpoint (ETag + s-maxage),
 *   so repeat visitors resolve from HTTP cache.
 * - Fail-open: any failure resolves to null — the guard simply never installs
 *   (hard loads are still covered by the proxy) and the next page load retries.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { buildConfigUrl, fetchProjectConfig } from '../config-fetch.ts';

const cache = new Map<string, Promise<ProjectConfig | null>>();

export interface GuardConfigSource {
  /** The same ProjectConfig the proxy uses (fixture or self-managed). Wins over `projectId`. */
  config?: ProjectConfig;
  /** Zero-config mode: fetch the config by project id, once per page load. */
  projectId?: string;
  /** Config host override. Default: the built-in host (`TESTA_CONFIG_HOST` on the server has no browser equivalent — pass `host` explicitly for staging). */
  host?: string;
}

/** Resolve the guard's config from its props. Never rejects. */
export function resolveGuardConfig(source: GuardConfigSource): Promise<ProjectConfig | null> {
  if (source.config) return Promise.resolve(source.config);
  if (!source.projectId) {
    // Loud in dev, silent no-op in prod (the guard is an optional enhancement).
    if (process.env.NODE_ENV !== 'production') {
      throw new Error('TestaRouterGuard: pass `projectId` (or an inline `config`)');
    }
    return Promise.resolve(null);
  }
  const url = buildConfigUrl(source.host ?? '', source.projectId);
  const cached = cache.get(url);
  if (cached) return cached;
  const pending = fetchProjectConfig(url).then((config) => {
    // Don't cache a failure across the page's lifetime — allow a later mount
    // (e.g. after a transient network error) to retry.
    if (config === null) cache.delete(url);
    return config;
  });
  cache.set(url, pending);
  return pending;
}

/** Test hook: forget cached fetches. */
export function clearGuardConfigCache(): void {
  cache.clear();
}
