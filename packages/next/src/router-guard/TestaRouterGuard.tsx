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

import { ASSIGNMENT_COOKIE } from '@testa-platform/experiment-core';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { installRouterGuard } from './use-cookie-assignment.ts';

export interface TestaRouterGuardProps {
  /** The same ProjectConfig the middleware uses (local fixture or fetched once). */
  config: ProjectConfig;
}

export function TestaRouterGuard({ config }: TestaRouterGuardProps): null {
  const router = useRouter();

  useEffect(() => {
    return installRouterGuard(router, {
      config,
      getCookieValue: () => readCookie(ASSIGNMENT_COOKIE),
      toAbsoluteUrl: (path) =>
        typeof window !== 'undefined' ? new URL(path, window.location.origin).href : path,
    });
    // router.events identity is stable for the app lifetime; re-subscribe only if
    // the config object changes.
  }, [router, config]);

  return null;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
