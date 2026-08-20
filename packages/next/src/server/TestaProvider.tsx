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
 * `@testa-soft/next/experiments`, NOT a relative path. A relative import would
 * make tsup inline the client component into THIS server bundle, destroying the
 * `"use client"` boundary (Next would then crash on usePathname/useEffect in a
 * server module). Keeping it external means the built server bundle still imports
 * `@testa-soft/next/experiments`, which resolves via package-exports
 * self-reference to the built client entry that carries the directive.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { TestaProvider as TestaProviderClient } from '@testa-soft/next/experiments';
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
}

/**
 * Either fetch by `projectId` (the normal path) or supply an inline `config`
 * (zero-infra). Inline `config` always wins when both are present.
 */
export type TestaProviderProps = CommonProps &
  ({ projectId: string; config?: ProjectConfig } | { config: ProjectConfig; projectId?: string });

export async function TestaProvider(props: TestaProviderProps): Promise<JSX.Element | null> {
  const resolved = await resolveConfig(props);
  // Fail open: mirrors marketing-web's `{config && <TestaProvider/>}` — no
  // config means nothing to apply, so render nothing.
  if (!resolved) return null;

  return (
    <TestaProviderClient
      config={resolved}
      {...(props.previewApiUrl ? { previewApiUrl: props.previewApiUrl } : {})}
      {...(props.trackingHost ? { trackingHost: props.trackingHost } : {})}
    />
  );
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
