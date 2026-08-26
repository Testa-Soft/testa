/**
 * `<TestaProvider/>` — the one-component client integration. Mount it once at
 * the app root.
 *
 * It fetches the config as early as a client package can — kicked off during the
 * FIRST RENDER (a `useState` initializer, before children render or effects run)
 * via the module-level `preloadConfig` cache, which makes StrictMode's
 * double-invoke and remounts collapse onto one request.
 *
 * SMART SHIELD: it manages the anti-flicker overlay automatically. On mount
 * (pre-paint, after DOM commit) it raises the
 * shield when the persisted hint says the project has something to hide — see
 * `shield-hint.ts`. The app no longer needs a manual `<TestaShield/>` (though an
 * even-earlier `index.html` snippet still composes: `raiseShield` is idempotent
 * by `styleId`). Set `shield={false}` to opt out and manage it yourself.
 *
 * After the config resolves it builds a `DocumentCookieStore`, runs `initTesta`
 * (assign → redirect or apply DOM), refreshes the shield hint, then reveals the
 * shield once the variant has painted. It installs the framework-agnostic SPA
 * navigation detector to re-run the cycle on every route change (disposing the
 * previous cycle's DOM teardowns first; the shield is never re-raised after the
 * initial reveal). The assignment map is provided via context so
 * `useTestaVariant` works. Everything is torn down on unmount.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import {
  SHIELD_CSS_STYLE_ID,
  type Shield,
  type ShieldOptions,
  type Teardown,
  raiseShield,
} from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * Both effects below run pre-paint on purpose — that is the whole point of a
 * shield. But React logs a warning when a component that renders on the SERVER
 * uses `useLayoutEffect`, and this provider does render there: the Pages Router
 * SSRs it from `_app.tsx`. The warning is right in general and wrong here —
 * there is no paint to get ahead of on the server, and the effect deliberately
 * does nothing until hydration. Swapping the hook keeps the browser timing
 * identical and stops the noise in every SSR app's logs.
 */
const useBeforePaint = typeof document === 'undefined' ? useEffect : useLayoutEffect;
import { revealShield } from './apply-assignments.ts';
import { preloadConfig } from './config.ts';
import { TestaContext, type TestaContextValue } from './context.ts';
import { DocumentCookieStore } from './cookie-store.ts';
import { initTesta } from './init.ts';
import { configNeedsShield, readShieldHint, writeShieldHint } from './shield-hint.ts';
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
  /** Host for exposure tracking. Default `https://new.testa-soft.tech`. */
  trackingHost?: string;
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secureCookies?: boolean;
  /** Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`). */
  cookieDomain?: string;
  /**
   * Anti-flicker shield control. Default `true` — the provider auto-raises the
   * shield on mount when the persisted hint says the project has something to
   * hide, and reveals it once the variant paints. Pass `ShieldOptions` to
   * customise (selector/timeout/etc). Pass `false` to opt out entirely and
   * manage the shield yourself (e.g. an `index.html` snippet / `<TestaShield/>`).
   */
  shield?: boolean | ShieldOptions;
}

export function TestaProvider(props: TestaProviderProps): JSX.Element {
  const [value, setValue] = useState<Omit<TestaContextValue, 'settled'>>({
    config: null,
    assignments: new Map(),
  });
  const [settled, setSettled] = useState(false);
  const shieldHandleRef = useRef<Shield | null>(null);

  // EAGER FETCH: kick the request off during first render (before children
  // render, before effects) so config resolution overlaps React's initial work.
  // The module-level cache makes StrictMode's double-invoke a single request.
  const [configPromise] = useState(() =>
    preloadConfig({
      ...(props.config ? { config: props.config } : {}),
      ...(props.projectId ? { projectId: props.projectId } : {}),
      ...(props.host ? { host: props.host } : {}),
    }),
  );

  // AUTO-SHIELD: raise as early as a client package can (after DOM commit, before
  // first paint) when enabled and the hint isn't an explicit "nothing to hide".
  // `raiseShield` is idempotent by styleId, so it composes with an index.html
  // snippet instead of double-shielding. Runs once on mount — the empty dep
  // array is deliberate, props are captured on first render.
  useBeforePaint(() => {
    const shieldOpt = props.shield ?? true;
    if (shieldOpt === false) return; // app manages its own shield
    // A server-rendered shield is already hiding the content — and it went up
    // BEFORE first paint, which this effect cannot. Raising a second one would
    // add a redundant style element and nothing else.
    if (typeof document !== 'undefined' && document.getElementById(SHIELD_CSS_STYLE_ID)) return;
    if (readShieldHint() === false) return; // last load had nothing to hide
    shieldHandleRef.current = raiseShield(typeof shieldOpt === 'object' ? shieldOpt : {});
  }, []);

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
      if (result.redirected) {
        // Navigating away via location.replace. On the INITIAL load the shield
        // is still up; on a SOFT-NAV redirect it was revealed long ago — re-raise
        // it (idempotent) so the control page never flashes while the browser
        // performs the full navigation to the variant URL.
        const shieldOpt = props.shield ?? true;
        if (shieldOpt !== false) {
          shieldHandleRef.current = raiseShield(typeof shieldOpt === 'object' ? shieldOpt : {});
        }
        return;
      }
      teardowns = result.teardowns;
      setValue({ config, assignments: buildAssignmentMap(store.get(ASSIGNMENT_COOKIE)) });
      setSettled(true); // shield revealed post-commit (pre-paint effect below), after the variant paints
    };

    void (async () => {
      const config = await configPromise;
      if (disposed) return;
      if (!config) {
        setSettled(true); // fail open — never leave the page hidden
        return;
      }
      // Refresh the persisted hint for the NEXT load now that we know the truth.
      writeShieldHint(configNeedsShield(config));
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
  // Reveal both the auto-raised handle (covers a custom styleId) and any
  // snippet-raised shield via `window.__testa_shield` — both are idempotent.
  useBeforePaint(() => {
    if (!settled) return;
    shieldHandleRef.current?.reveal();
    revealShield();
  }, [settled]);

  // `settled` rides along in context so a server-rendered shield (the Pages
  // Router head shield) can unrender itself at exactly the moment this provider
  // reveals its own — one signal, no second timer.
  const ctxValue = useMemo<TestaContextValue>(() => ({ ...value, settled }), [value, settled]);

  return <TestaContext.Provider value={ctxValue}>{props.children}</TestaContext.Provider>;
}
