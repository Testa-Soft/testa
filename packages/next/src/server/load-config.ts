/**
 * `loadTestaConfig` — server-side config resolution for the RSC surface.
 *
 * The React Server Components (`<TestaProvider projectId=.../>`) resolve the
 * same `ProjectConfig` the middleware uses, so the app never needs its own
 * config-fetch code. Resolution order:
 *
 *   1. The instrumentation poller's snapshot (`registerTestaConfig` in the
 *      app's instrumentation.ts) — a synchronous in-process read, so a polled
 *      deployment NEVER fetches from the render path.
 *   2. A fetch cached by Next's data cache (stale-while-revalidate) via the
 *      `next.revalidate` option — downloaded once, refreshed in the background
 *      thereafter — with a hard latency budget so a slow config origin can
 *      never stall a render beyond it.
 *
 * It fails OPEN: any failure (unreachable host, timeout, non-2xx,
 * malformed/invalid body) returns null so the caller renders nothing rather
 * than a shield nothing will reveal. This mirrors the middleware's own
 * fail-open behaviour.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { buildConfigUrl, fetchProjectConfig } from '../config-fetch.ts';
import { readConfigSnapshot } from '../config-snapshot.ts';

/** Default Next data-cache revalidate window (seconds). Matches the middleware's TTL. */
const DEFAULT_REVALIDATE_SEC = 60;

export interface LoadTestaConfigOptions {
  /** Project id — config is fetched from `{host}/api/v1/config/{projectId}`. */
  projectId: string;
  /**
   * Config host. Defaults to the `TESTA_CONFIG_HOST` env var, then the built-in
   * `DEFAULT_CONFIG_HOST` — matching the middleware's host resolution. Trailing
   * slashes are trimmed.
   */
  host?: string;
  /** Next data-cache revalidate window in seconds. Default 60. */
  revalidateSec?: number;
  /** Latency budget per fetch (ms). Default `DEFAULT_FETCH_TIMEOUT_MS` (2s). */
  fetchTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * `RequestInit` doesn't type Next's `next` extension, so we widen locally. Outside
 * Next the key is simply ignored; inside Next it drives the data cache.
 */
type NextRequestInit = RequestInit & { next?: { revalidate?: number } };

export async function loadTestaConfig(opts: LoadTestaConfigOptions): Promise<ProjectConfig | null> {
  // Poller snapshot first — same-process, synchronous, no network. It wins
  // unconditionally so the render and the (Node-runtime) proxy can never
  // disagree on which config a request ran under.
  const snapshot = readConfigSnapshot(opts.projectId);
  if (snapshot) return snapshot;

  const revalidate = opts.revalidateSec ?? DEFAULT_REVALIDATE_SEC;
  const init: NextRequestInit = { next: { revalidate } };
  return fetchProjectConfig(buildConfigUrl(opts.host ?? '', opts.projectId), {
    ...(opts.fetchTimeoutMs !== undefined ? { timeoutMs: opts.fetchTimeoutMs } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    init,
  });
}
