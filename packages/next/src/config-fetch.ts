/**
 * Shared config-fetch primitives: URL building, a hard latency budget, and
 * boundary validation. Used by the middleware's `ConfigClient`, the RSC
 * `loadTestaConfig`, and the instrumentation poller so all three fetch the
 * same way and none can hang a request.
 *
 * The timeout is the important part: without it, a slow (not down — down
 * fails fast) config origin stalls whatever awaited the fetch until the
 * platform kills it. With it, the worst case anywhere in the SDK is one
 * budget-capped await per cold instance. Every failure mode — timeout,
 * network error, non-2xx, malformed body — resolves to `null` so callers
 * fail open (no experiments), never broken requests.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { DEFAULT_CONFIG_HOST, readEnv } from './constants.ts';

/**
 * Hard cap on a single config fetch, OFF the request path (poller, RSC loader
 * behind Next's data cache). Generous vs the CDN's typical ~50ms.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 2_000;

/**
 * Hard cap for the ONE fetch that can sit on the request path: the async
 * proxy's cold-instance fetch. Sized for a hot path, not an API call —
 * experiments are expendable per-request (fail open to no-experiments),
 * added latency never is. The CDN-cached config answers in ~50-100ms; a
 * request that would take longer forfeits its experiments instead of waiting.
 */
export const PROXY_FETCH_TIMEOUT_MS = 400;

/** Resolve the config host: explicit option → `TESTA_CONFIG_HOST` env → built-in. */
export function resolveConfigHost(host?: string): string {
  return (host || readEnv('TESTA_CONFIG_HOST') || DEFAULT_CONFIG_HOST).replace(/\/+$/, '');
}

/** Canonical config URL for a project on a host. */
export function buildConfigUrl(host: string, projectId: string): string {
  return `${resolveConfigHost(host)}/api/v1/config/${encodeURIComponent(projectId)}`;
}

export interface FetchProjectConfigOptions {
  /** Latency budget in ms. Default `DEFAULT_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra RequestInit merged in (e.g. Next's `next.revalidate` / `cache`). */
  init?: RequestInit;
}

/**
 * Fetch + validate a `ProjectConfig`. Returns null on ANY failure — including
 * the timeout — so callers can treat "no config" as the single degraded state.
 */
export async function fetchProjectConfig(
  url: string,
  options: FetchProjectConfigOptions = {},
): Promise<ProjectConfig | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const signal = createTimeoutSignal(timeoutMs);
  try {
    const res = await doFetch(url, {
      ...options.init,
      headers: { accept: 'application/json', ...headersOf(options.init) },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return isProjectConfig(body) ? body : null;
  } catch {
    // Timeout, network failure, malformed JSON — fail open, never throw.
    return null;
  }
}

/**
 * Light boundary validation: enough to reject an unrelated / error-shaped body
 * without pulling in a full schema. A valid config is a non-null object with an
 * `experiments` array.
 */
export function isProjectConfig(value: unknown): value is ProjectConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { experiments?: unknown }).experiments)
  );
}

/** `AbortSignal.timeout` where the runtime has it (Node 17.3+, modern edge). */
function createTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  if (!init?.headers) return {};
  return Object.fromEntries(new Headers(init.headers).entries());
}
