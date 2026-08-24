/**
 * `<TestaProvider/>` — `@testa-soft/next/pages`: the ONE component a Pages
 * Router app adds (in `_app.tsx`), twin of `@testa-soft/next/server`'s
 * provider for the App Router. Same name, one entry per router — a given app
 * file can only ever use one of them.
 *
 * It composes the client engine from `@testa-soft/react` (DOM changes, goals,
 * exposures, anti-flicker shield) with `<TestaRouterGuard/>` (pre-render
 * split-URL redirects on `next/link` soft navs — hard loads are the proxy's
 * job), so nothing needs to be wired by hand.
 *
 * ONE config fetch total: the guard does not fetch for itself here — this
 * component resolves the config through `preloadConfig`, the same module-level
 * cache the client provider fetches through, and hands the settled config to
 * the guard as a prop.
 *
 * Mounted in the App Router by mistake, everything still behaves: the client
 * engine works anywhere React does, and the guard no-ops without a Pages
 * Router (with a dev-time pointer to `/server`, which is the better surface
 * there — server-fetched config and the header-gated shield).
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  TestaProvider as TestaClientProvider,
  type TestaProviderProps as TestaClientProviderProps,
  preloadConfig,
} from '@testa-soft/react';
import { type JSX, useEffect, useState } from 'react';
import { TestaRouterGuard } from '../router-guard/TestaRouterGuard.tsx';

export type TestaProviderProps = TestaClientProviderProps;

export function TestaProvider(props: TestaProviderProps): JSX.Element {
  const { children, ...rest } = props;
  const [guardConfig, setGuardConfig] = useState<ProjectConfig | null>(props.config ?? null);

  useEffect(() => {
    if (props.config) {
      setGuardConfig(props.config);
      return;
    }
    let stale = false;
    // Rides the client provider's own request via the shared preload cache.
    void preloadConfig({
      ...(props.projectId ? { projectId: props.projectId } : {}),
      ...(props.host ? { host: props.host } : {}),
    }).then((config) => {
      if (!stale && config) setGuardConfig(config);
    });
    return () => {
      stale = true;
    };
  }, [props.config, props.projectId, props.host]);

  return (
    <TestaClientProvider {...rest}>
      {guardConfig ? <TestaRouterGuard config={guardConfig} /> : null}
      {children}
    </TestaClientProvider>
  );
}
