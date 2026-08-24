/**
 * `@testa-soft/next/instrumentation` — every-minute config polling for
 * long-lived Node servers, so no request ever awaits testa.
 *
 *   // instrumentation.ts (app root or /src)
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       const { registerTestaConfig } = await import('@testa-soft/next/instrumentation');
 *       await registerTestaConfig({ projectId: '3fa85f64e1c2b' });
 *     }
 *   }
 *
 * `register()` is awaited by Next during boot, so the FIRST fetch lands before
 * traffic does — the snapshot is warm for request #1 and refreshed on an
 * interval thereafter. `loadTestaConfig` / the RSC components read it in the
 * same process on any Next version; the proxy reads it only when the
 * middleware runs in the Node runtime (`runtime: 'nodejs'`, Next 15.2+) — the
 * default edge sandbox has its own isolated globals and keeps its SWR fetch
 * cache instead.
 *
 * Failure model: a failed poll (timeout, network, non-2xx, bad body) NEVER
 * downgrades the snapshot — last-known-good keeps serving and the next tick
 * retries. If testa is down at boot, the app starts with experiments off and
 * self-heals when polling succeeds.
 *
 * Serverless caveat: on frozen-between-requests platforms (Vercel functions,
 * Lambda) intervals don't tick — this entry is for genuinely long-lived
 * servers (Docker/k8s `next start`). Serverless deployments should keep the
 * proxy's built-in SWR cache or a push-based `loadConfig` (e.g. Edge Config).
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { buildConfigUrl, fetchProjectConfig } from '../config-fetch.ts';
import { clearConfigSnapshot, readConfigSnapshot, writeConfigSnapshot } from '../config-snapshot.ts';

// Snapshot access is re-exported for custom writers/readers (e.g. a publish
// webhook pushing the config instead of polling for it).
export { readConfigSnapshot, writeConfigSnapshot, clearConfigSnapshot };

/** Default poll interval — matches the proxy's SWR fresh window. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Floor guarding against accidental hot loops (`intervalMs: 100`). */
const MIN_INTERVAL_MS = 5_000;

export interface RegisterTestaConfigOptions {
  /** Project id — config is polled from `{host}/api/v1/config/{projectId}`. */
  projectId: string;
  /** Config host. Default: `TESTA_CONFIG_HOST` env, then the built-in host. */
  host?: string;
  /** Poll interval in ms. Default 60s; floored at 5s. */
  intervalMs?: number;
  /** Latency budget per poll (ms). Default `DEFAULT_FETCH_TIMEOUT_MS` (2s). */
  fetchTimeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface TestaConfigPoller {
  /** Poll once, immediately. Resolves true when the snapshot was updated. */
  refresh(): Promise<boolean>;
  /** Stop polling. The last snapshot stays in place (last-known-good). */
  stop(): void;
}

/** One live poller per projectId per process — re-registration replaces it. */
const REGISTRY_KEY = '__TESTA_CONFIG_POLLERS__';

function registry(): Map<string, TestaConfigPoller> {
  const host = globalThis as Record<string, unknown>;
  const existing = host[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, TestaConfigPoller>;
  const fresh = new Map<string, TestaConfigPoller>();
  host[REGISTRY_KEY] = fresh;
  return fresh;
}

export async function registerTestaConfig(
  options: RegisterTestaConfigOptions,
): Promise<TestaConfigPoller> {
  if (!options.projectId || typeof options.projectId !== 'string') {
    throw new Error('registerTestaConfig: `projectId` is required');
  }
  if (options.intervalMs !== undefined && !(options.intervalMs > 0)) {
    throw new Error('registerTestaConfig: `intervalMs` must be a positive number');
  }

  // Dev hot reloads / repeated register() calls: replace, never stack timers.
  registry().get(options.projectId)?.stop();

  const url = buildConfigUrl(options.host ?? '', options.projectId);
  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);

  const refresh = async (): Promise<boolean> => {
    const config: ProjectConfig | null = await fetchProjectConfig(url, {
      ...(options.fetchTimeoutMs !== undefined ? { timeoutMs: options.fetchTimeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      // Bypass Next's patched-fetch data cache — the poller IS the cache.
      init: { cache: 'no-store' },
    });
    if (!config) return false; // failed poll keeps last-known-good
    writeConfigSnapshot(options.projectId, config, Date.now());
    return true;
  };

  // First poll is awaited by the caller (Next awaits register()), so the
  // snapshot is warm before the first request. A failure here is not fatal —
  // the interval below self-heals.
  await refresh();

  const timer = setInterval(() => void refresh(), intervalMs);
  // Never hold the process open for the poller (test runners, graceful exits).
  (timer as { unref?: () => void }).unref?.();

  const poller: TestaConfigPoller = {
    refresh,
    stop: () => {
      clearInterval(timer);
      registry().delete(options.projectId);
    },
  };
  registry().set(options.projectId, poller);
  return poller;
}
