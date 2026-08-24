'use client';

/**
 * `<TestaRouterGuard/>` (task N.6, M2) — the optional client-side catch-all for
 * soft navigations the middleware can't see (Pages-Router-static navs never hit
 * the server). Add it ONCE in the layout; no per-page work.
 *
 * It is cookie-first: it reads the sticky `_testa_exp` assignment via
 * experiment-core (no re-roll, no config re-fetch) and, on a navigation to a
 * control URL for an experiment the visitor is bucketed to a variant of, aborts
 * the in-flight navigation in `routeChangeStart` and `router.replace()`s to the
 * variant before the control page renders. A visitor gets the same variant
 * whether the middleware (M1) or this guard (M2) fires — both read one cookie.
 *
 * All logic lives in `use-cookie-assignment.ts` (framework-agnostic, unit
 * tested); this file is only the React + `next/router` glue.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
// compat/router returns null instead of THROWING when no Pages Router is
// mounted, so accidentally shipping this component inside the App Router
// degrades to a no-op (correct there — the proxy already covers App-Router
// soft navs) instead of a crash. A dev-time warning still points at /server.
import { useRouter } from 'next/compat/router.js';
import { useEffect } from 'react';
import { readClientCookie } from '../client-cookie.ts';
import { type GuardConfigSource, resolveGuardConfig } from './guard-config.ts';
import { installRouterGuard } from './use-cookie-assignment.ts';

/**
 * Zero-config mode (`projectId`) fetches the same servable config the proxy
 * uses — once per page load, shared across mounts, from the CDN-cached
 * endpoint. Inline `config` wins when both are passed. See guard-config.ts.
 */
export type TestaRouterGuardProps = GuardConfigSource;

export function TestaRouterGuard(props: TestaRouterGuardProps): null {
  const router = useRouter();
  const { config, projectId, host } = props;

  useEffect(() => {
    if (!router) {
      // App Router (or no router mounted): the guard is unnecessary there —
      // the proxy sees App-Router soft navs. No-op, with a dev-time pointer.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          '[testa] <TestaRouterGuard/> found no Pages Router — it is a no-op here. ' +
            'In the App Router use <TestaProvider/> from @testa-soft/next/server instead.',
        );
      }
      return;
    }
    let uninstall: (() => void) | undefined;
    let unmounted = false;

    void resolveGuardConfig({
      ...(config ? { config } : {}),
      ...(projectId ? { projectId } : {}),
      ...(host ? { host } : {}),
    }).then((resolved: ProjectConfig | null) => {
      if (!resolved || unmounted) return; // fail open — hard loads still covered by the proxy
      uninstall = installRouterGuard(router, {
        config: resolved,
        getCookieValue: () => readClientCookie(ASSIGNMENT_COOKIE),
        toAbsoluteUrl: (path) =>
          typeof window !== 'undefined' ? new URL(path, window.location.origin).href : path,
      });
    });

    return () => {
      unmounted = true;
      uninstall?.();
    };
    // router.events identity is stable for the app lifetime; re-subscribe only
    // if the config source changes.
  }, [router, config, projectId, host]);

  return null;
}
