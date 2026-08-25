/**
 * `<TestaProvider/>` — `@testa-soft/next/pages`: the ONE component a Pages
 * Router app adds (in `_app.tsx`), twin of `@testa-soft/next/server`'s
 * provider for the App Router. Same name, one entry per router — a given app
 * file can only ever use one of them.
 *
 * It composes the client engine from `@testa-soft/react` (DOM changes, goals,
 * exposures) with `<TestaRouterGuard/>` (pre-render split-URL redirects on
 * `next/link` soft navs — hard loads are the proxy's job) and `<HeadShield/>`,
 * so nothing needs to be wired by hand.
 *
 * ANTI-FLICKER IS ON BY DEFAULT and needs no `_document.tsx`: `<HeadShield/>`
 * renders a JS-free `<style>` into `<head>` via `next/head` — server-rendered,
 * therefore in place before the browser's first paint — and unrenders it the
 * moment the variant is applied. A client-only shield can't do this: an effect
 * runs after the control content has painted, which turns one flash into two
 * (content → blank → variant). Pass `shield={false}` to own it yourself.
 *
 * ONE config fetch per page load, total. The guard cannot fetch — it only
 * takes a resolved `config` prop. This component resolves the config through
 * `preloadConfig`, the SAME module-level cache the client provider fetches
 * through, so both calls collapse onto one request (StrictMode's double-mount
 * included) and the settled config is handed to the guard as a prop.
 *
 * Nothing refetches on soft navigation either: the client engine re-runs its
 * apply cycle against the config it already holds, and the guard re-installs
 * only if the config object itself changes.
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
import { HeadShield } from './HeadShield.tsx';

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
      {/* Rendered inside the client provider so it can read `settled` from its
          context — and so the shield goes down the moment the variant is on. */}
      <HeadShield
        {...(props.shield !== undefined ? { shield: props.shield } : {})}
        {...(props.config ? { config: props.config } : {})}
      />
      {guardConfig ? <TestaRouterGuard config={guardConfig} /> : null}
      {children}
    </TestaClientProvider>
  );
}
