/**
 * `<TestaProvider/>` — the React Server Component wrapper around the client
 * DOM-experiment applier.
 *
 * It resolves the `ProjectConfig` server-side (fetched once, cached by Next's
 * data cache) and hands it to the client component, so the app needs NO
 * config-fetch code of its own — just drop `<TestaProvider projectId=.../>`
 * in the root layout. An inline `config` prop short-circuits the fetch entirely
 * (the zero-infra / demo path).
 *
 * CRITICAL: the client component is imported via the bare self-reference
 * `@testa-soft/next/_internal/experiments`, NOT a relative path. A relative
 * import would make tsup inline the client component into THIS server bundle,
 * destroying the `"use client"` boundary (Next would then crash on
 * usePathname/useEffect in a server module). Keeping it external means the built
 * server bundle still imports `@testa-soft/next/_internal/experiments`, which
 * resolves via package-exports self-reference to the built client entry that
 * carries the directive. That self-reference is the ONLY reason the `_internal`
 * path is in the exports map at all — it is not a public API.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { TestaProvider as TestaProviderClient } from '@testa-soft/next/_internal/experiments';
import { loadTestaConfig } from './load-config.ts';

interface CommonProps {
  /** Config host override (see `loadTestaConfig`). Ignored when `config` is inline. */
  host?: string;
  /** Backend base URL for preview mode (crobot); passed straight to the client. */
  previewApiUrl?: string;
  /** crobot base URL for goal conversions; passed straight to the client. */
  trackingHost?: string;
  /** Next data-cache revalidate window (seconds). Ignored when `config` is inline. */
  revalidateSec?: number;
  /**
   * Emit the exposure when the CLIENT assigns (the cold fallback below). Mirror
   * the proxy's own `tracking` so a project with tracking off doesn't start
   * reporting from the browser. Default true.
   */
  tracking?: boolean;
  /** `Secure` on client-written cookies. Default true; false for local http dev. */
  secureCookies?: boolean;
  /**
   * Cookie `Domain` for client-written cookies — pass the SAME value the proxy
   * uses (`cookieDomain` / `discoverRootDomain`), or the fallback's cookie lands
   * at a different scope than the proxy's.
   */
  cookieDomain?: string;
}

/**
 * Either fetch by `projectId` (the normal path) or supply an inline `config`
 * (zero-infra). Inline `config` always wins when both are present.
 */
export type TestaProviderProps = CommonProps &
  ({ projectId: string; config?: ProjectConfig } | { config: ProjectConfig; projectId?: string });

export async function TestaProvider(props: TestaProviderProps): Promise<JSX.Element | null> {
  const resolved = await resolveConfig(props);

  // Neither a config nor a projectId: there is nothing for either side to work
  // with, so render nothing (a caller can still violate the prop union at
  // runtime). Every other case renders the client — see below.
  if (!resolved && !props.projectId) return null;

  // The client is rendered EVEN WITHOUT a config. A server-side fetch failure
  // (unreachable from the server, a null baked into a static prerender, a
  // 2s-budget timeout) used to render nothing at all — which meant no
  // experiments on that page for as long as the failure lasted, since the
  // client had no way to recover. With `projectId` it fetches its own config
  // and owns the pageview instead.
  return (
    <TestaProviderClient
      {...(resolved ? { config: stripServerGeo(resolved) } : {})}
      {...(props.projectId ? { projectId: props.projectId } : {})}
      {...(props.host ? { host: props.host } : {})}
      {...(props.previewApiUrl ? { previewApiUrl: props.previewApiUrl } : {})}
      {...(props.tracking !== undefined ? { tracking: props.tracking } : {})}
      {...(props.trackingHost ? { trackingHost: props.trackingHost } : {})}
      {...(props.secureCookies !== undefined ? { secureCookies: props.secureCookies } : {})}
      {...(props.cookieDomain ? { cookieDomain: props.cookieDomain } : {})}
    />
  );
}

/**
 * Drop `geo` from a SERVER-fetched config before handing it to the client.
 *
 * The geo worker splices the geo of whoever fetched the config — for this fetch
 * that's the datacenter, not the visitor. Passing it on would let a
 * country-gated rule be judged by the region the app happens to run in. A
 * config the CLIENT fetches keeps its geo, because there the requester IS the
 * visitor.
 */
function stripServerGeo(config: ProjectConfig): ProjectConfig {
  if (!config.geo) return config;
  const { geo: _geo, ...rest } = config;
  return rest;
}

/** Inline config wins; otherwise fetch by projectId. Null when neither is usable. */
async function resolveConfig(props: TestaProviderProps): Promise<ProjectConfig | null> {
  if (props.config) return props.config;
  if (!props.projectId) return null;
  return loadTestaConfig({
    projectId: props.projectId,
    ...(props.host ? { host: props.host } : {}),
    ...(props.revalidateSec !== undefined ? { revalidateSec: props.revalidateSec } : {}),
  });
}
