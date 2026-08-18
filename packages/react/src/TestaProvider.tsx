/**
 * `<TestaProvider/>` — the one-component client integration. Mount it once at
 * the app root.
 *
 * On mount it: resolves the config (inline or fetched by `projectId`), builds a
 * `DocumentCookieStore`, runs `initTesta` (assign → redirect or apply DOM), and
 * reveals the anti-flicker shield. It then installs the framework-agnostic SPA
 * navigation detector to re-run the cycle on every route change (disposing the
 * previous cycle's DOM teardowns first). The resolved assignment map is provided
 * via context so `useTestaVariant` works. Everything is torn down on unmount.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import type { Teardown } from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import { revealShield } from './apply-assignments.ts';
import { ConfigClient } from './config.ts';
import { TestaContext, type TestaContextValue } from './context.ts';
import { DocumentCookieStore } from './cookie-store.ts';
import { initTesta } from './init.ts';
import { installSpaNav } from './spa-nav.ts';
import { buildAssignmentMap } from './use-variant.ts';

export interface TestaProviderProps {
  children?: ReactNode;
  /** Project id — config is fetched from `{host}/api/v1/config/{projectId}`. */
  projectId?: string;
  /** Inline `ProjectConfig` — zero-latency, no network. Wins over `projectId`. */
  config?: ProjectConfig;
  /** Config host. Default `https://config.testa-soft.tech`. */
  host?: string;
  /** Backend base URL for preview mode (`?testa_preview`). */
  previewApiUrl?: string;
  /** Emit exposures on fresh enrollment. Default true. */
  tracking?: boolean;
  /** Host for exposure tracking. Default `https://app.testa-soft.tech`. */
  trackingHost?: string;
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secureCookies?: boolean;
  /** Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`). */
  cookieDomain?: string;
}

export function TestaProvider(props: TestaProviderProps): JSX.Element {
  const [value, setValue] = useState<TestaContextValue>({
    config: null,
    assignments: new Map(),
  });
  const [settled, setSettled] = useState(false);

  // Mount-once: config + options are captured on first render. A config swap is
  // rare in an SPA; remount the provider (or reload) to pick up a new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    let disposed = false;
    let teardowns: Teardown[] = [];
    let uninstallNav: () => void = () => undefined;

    const store = new DocumentCookieStore({
      secure: props.secureCookies ?? true,
      ...(props.cookieDomain ? { domain: props.cookieDomain } : {}),
    });
    const client = new ConfigClient({
      ...(props.config ? { config: props.config } : {}),
      ...(props.projectId ? { projectId: props.projectId } : {}),
      ...(props.host ? { host: props.host } : {}),
    });

    const disposeTeardowns = (list: Teardown[]): void => {
      for (const t of list) {
        try {
          t();
        } catch {
          // never let a teardown break the next cycle / unmount
        }
      }
    };

    const cycle = async (config: ProjectConfig): Promise<void> => {
      disposeTeardowns(teardowns);
      teardowns = [];
      const result = await initTesta({
        config,
        currentUrl: typeof window !== 'undefined' ? window.location.href : '',
        store,
        ...(props.previewApiUrl ? { previewApiUrl: props.previewApiUrl } : {}),
        ...(props.tracking !== undefined ? { tracking: props.tracking } : {}),
        ...(props.trackingHost ? { trackingHost: props.trackingHost } : {}),
      });
      if (disposed) {
        disposeTeardowns(result.teardowns);
        return;
      }
      if (result.redirected) return; // navigating away — leave the shield up
      teardowns = result.teardowns;
      setValue({ config, assignments: buildAssignmentMap(store.get(ASSIGNMENT_COOKIE)) });
      setSettled(true); // shield revealed post-commit (useLayoutEffect below), after the variant paints
    };

    void (async () => {
      const config = await client.get(Date.now());
      if (disposed) return;
      if (!config) {
        setSettled(true); // fail open — never leave the page hidden
        return;
      }
      try {
        await cycle(config);
      } catch {
        // initTesta threw (bad config, DOM apply error): fail open so a broken
        // experiment never leaves the page shielded/blank.
        if (!disposed) setSettled(true);
        return;
      }
      if (disposed) return;
      uninstallNav = installSpaNav(() => {
        // Later cycles run after the shield is already down; swallow so a nav-time
        // failure never becomes an unhandled rejection.
        void cycle(config).catch(() => undefined);
      });
    })();

    return () => {
      disposed = true;
      disposeTeardowns(teardowns);
      uninstallNav();
    };
  }, []);

  // Reveal the shield only AFTER the assigned variant has been committed +
  // painted (a synchronous reveal races the code-based useTestaVariant render).
  useLayoutEffect(() => {
    if (settled) revealShield();
  }, [settled]);

  return <TestaContext.Provider value={value}>{props.children}</TestaContext.Provider>;
}
