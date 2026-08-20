/**
 * `loadTestaConfig` — server-side config fetch for the RSC surface.
 *
 * The React Server Components (`<TestaExperiments projectId=.../>`) resolve the
 * same `ProjectConfig` the middleware uses, so the app never needs its own
 * config-fetch code. Fetching happens on the first server-side request and is
 * cached by Next's data cache (stale-while-revalidate) via the `next.revalidate`
 * option — downloaded once, refreshed in the background thereafter.
 *
 * It fails OPEN: any failure (unreachable host, non-2xx, malformed/invalid body)
 * returns null so the caller renders nothing rather than a shield nothing will
 * reveal. This mirrors the middleware's own fail-open behaviour.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { DEFAULT_CONFIG_HOST, readEnv } from '../constants.ts';

/** Default Next data-cache revalidate window (seconds). Matches the middleware's TTL. */
const DEFAULT_REVALIDATE_SEC = 1800;

export interface LoadTestaConfigOptions {
  /** Project id — config is fetched from `{host}/api/v1/config/{projectId}`. */
  projectId: string;
  /**
   * Config host. Defaults to the `TESTA_CONFIG_HOST` env var, then the built-in
   * `DEFAULT_CONFIG_HOST` — matching the middleware's host resolution. Trailing
   * slashes are trimmed.
   */
  host?: string;
  /** Next data-cache revalidate window in seconds. Default 30. */
  revalidateSec?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * `RequestInit` doesn't type Next's `next` extension, so we widen locally. Outside
 * Next the key is simply ignored; inside Next it drives the data cache.
 */
type NextRequestInit = RequestInit & { next?: { revalidate?: number } };

export async function loadTestaConfig(opts: LoadTestaConfigOptions): Promise<ProjectConfig | null> {
  const host = (opts.host || readEnv('TESTA_CONFIG_HOST') || DEFAULT_CONFIG_HOST).replace(
    /\/+$/,
    '',
  );
  const revalidate = opts.revalidateSec ?? DEFAULT_REVALIDATE_SEC;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${host}/api/v1/config/${encodeURIComponent(opts.projectId)}`;
  const init: NextRequestInit = {
    headers: { accept: 'application/json' },
    next: { revalidate },
  };

  try {
    const res = await doFetch(url, init as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isProjectConfig(body) ? body : null;
  } catch {
    // Never let a config-fetch failure break the render — fail open (no experiment).
    return null;
  }
}

/**
 * Light boundary validation: enough to reject an unrelated / error-shaped body
 * without pulling in a full schema. A valid config is a non-null object with an
 * `experiments` array.
 */
function isProjectConfig(value: unknown): value is ProjectConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { experiments?: unknown }).experiments)
  );
}
