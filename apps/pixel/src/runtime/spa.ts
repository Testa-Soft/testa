/**
 * SPA navigation handler — listens for `_testa:locationchange` events the
 * loader's monkey-patch dispatches, debounces bursts, decides whether the URL
 * change is meaningful, and re-runs a caller-supplied cycle when it is.
 *
 * Burst-coalescing is the load-bearing piece. Next.js fires `replaceState`
 * then `pushState` for the same client-side navigation; React 18 transitions
 * can fan out into 2–3 history calls. A single 50 ms debounce flattens those
 * into one re-eval.
 *
 * Same-URL `pushState` (frameworks calling pushState(state, '', location.href)
 * to update history state without changing the URL) is dropped via the
 * canonical-URL diff in `url-canonical.ts`.
 *
 * Out of scope here:
 *   - The patch itself (lives in `../loader/monkey-patch.ts`).
 *   - The cycle this re-runs (caller supplies it; the lifecycle module wires).
 *   - `spa.hash_routes` per-project setting (read in lifecycle, passed in here).
 */

import { canonicalize } from './url-canonical.ts';

export const LOCATIONCHANGE_EVENT = '_testa:locationchange' as const;
export const DEBOUNCE_MS = 50;
const DEBUG_RING_SIZE = 20;

export interface InstallSpaOptions {
  /** Called when a meaningful URL transition happens. */
  onTransition: (canonicalUrl: string) => void;
  /**
   * Called SYNCHRONOUSLY on the first nav event of a burst, before the debounce
   * — the hook for tearing applied DOM changes back down. A soft nav swaps the
   * page's content while the variant's mutations are still in the DOM, so
   * waiting for the debounced cycle would show variant content on the new page
   * for `DEBOUNCE_MS`+. Only fires when the canonical URL actually differs, so
   * a same-URL `pushState` never wipes anything.
   *
   * Whatever it tore down is put back by `onTransition`, which is guaranteed to
   * run after this fires (even if the URL settles back to where it started).
   */
  onNavigate?: () => void;
  /** Per-project hash-routes setting. Default false. */
  includeHash?: boolean;
  /** Test injection for `Date.now`. */
  now?: () => number;
}

interface SpaDebug {
  ring: Array<{ ts: number; from: string; to: string; debounced: boolean; sameCanonical: boolean }>;
}

declare global {
  interface Window {
    __testa_spa_debug?: SpaDebug;
  }
}

/**
 * Install the listeners. Returns an `uninstall()` function — used by tests
 * to clean up between cases. Idempotent: a second call replaces the prior
 * listener instead of stacking.
 *
 * The lifecycle module calls this once at hydrate() time.
 */
export function installSpaHandler(opts: InstallSpaOptions): () => void {
  const includeHash = opts.includeHash ?? false;
  const now = opts.now ?? Date.now;

  let lastCanonical = canonicalize(window.location.href, { includeHash });
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingDebouncedCount = 0;
  /** True once `onNavigate` tore changes down and the re-apply hasn't run yet. */
  let killed = false;

  const ring: SpaDebug['ring'] = [];

  function pushDebug(entry: SpaDebug['ring'][number]): void {
    ring.push(entry);
    if (ring.length > DEBUG_RING_SIZE) ring.splice(0, ring.length - DEBUG_RING_SIZE);
    window.__testa_spa_debug = { ring };
  }

  function onChange(): void {
    pendingDebouncedCount += 1;

    // Kill applied changes NOW, undebounced — but only on a real URL change, or
    // a framework's same-URL `pushState` would wipe the variant with no cycle
    // coming to restore it. `killed` makes the debounced pass re-run even when
    // the URL settles back to `lastCanonical` (A→B→A inside one burst), so a
    // teardown is never left without its matching re-apply.
    if (opts.onNavigate && canonicalize(window.location.href, { includeHash }) !== lastCanonical) {
      killed = true;
      try {
        opts.onNavigate();
      } catch (err) {
        // Teardown must never blank the page or abort the cycle. Swallow + log.
        // eslint-disable-next-line no-console
        console.error('[testa] SPA teardown threw:', err);
      }
    }

    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const wasDebounced = pendingDebouncedCount > 1;
      pendingDebouncedCount = 0;

      const next = canonicalize(window.location.href, { includeHash });
      const sameCanonical = next === lastCanonical;
      pushDebug({
        ts: now(),
        from: lastCanonical,
        to: next,
        debounced: wasDebounced,
        sameCanonical,
      });

      // `killed` forces the cycle even on a same-canonical settle — we already
      // tore the changes down and MUST re-apply (re-bucketed, cookie-first).
      if (sameCanonical && !killed) return;
      killed = false;
      lastCanonical = next;
      try {
        opts.onTransition(next);
      } catch (err) {
        // Cycle-throwing must NEVER blank the page. Swallow + log.
        // eslint-disable-next-line no-console
        console.error('[testa] SPA cycle threw:', err);
      }
    }, DEBOUNCE_MS);
  }

  window.addEventListener(LOCATIONCHANGE_EVENT, onChange);
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);

  return () => {
    window.removeEventListener(LOCATIONCHANGE_EVENT, onChange);
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('hashchange', onChange);
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}
