/**
 * Framework-agnostic SPA navigation detector.
 *
 * A pure client SPA changes the URL without a document load, so the engine must
 * be re-run on every soft navigation. Rather than couple to any one router, this
 * monkey-patches `history.pushState` / `history.replaceState` (once, globally)
 * and listens to `popstate`, dispatching a single custom event on any URL
 * change. It therefore works with React Router, TanStack Router, Wouter, or hand
 * -rolled `history` navigation alike.
 *
 * `installSpaNav(cb)` subscribes `cb` to that event, de-duped so it only fires
 * when the URL actually changed, and returns an idempotent uninstall function.
 * SSR-safe: a no-op uninstall is returned when there is no `window`.
 */

export const LOCATION_CHANGE_EVENT = 'testa:locationchange';

interface PatchedHistory extends History {
  __testaPatched?: boolean;
}

/** Patch `history` + `popstate` to emit {@link LOCATION_CHANGE_EVENT}. Idempotent. */
function ensurePatched(): void {
  if (typeof window === 'undefined') return;
  const history = window.history as PatchedHistory;
  if (history.__testaPatched) return;
  history.__testaPatched = true;

  const dispatch = (): void => {
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
  };

  const originalPush = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>): void => {
    originalPush(...args);
    dispatch();
  };

  const originalReplace = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    originalReplace(...args);
    dispatch();
  };

  window.addEventListener('popstate', dispatch);
}

/**
 * Invoke `onNavigate` on each SPA URL change. Returns an uninstall function that
 * removes this listener (the global history patch stays — it's shared + inert).
 */
export function installSpaNav(onNavigate: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  ensurePatched();

  let lastHref = window.location.href;
  const handler = (): void => {
    const href = window.location.href;
    if (href === lastHref) return;
    lastHref = href;
    onNavigate();
  };

  window.addEventListener(LOCATION_CHANGE_EVENT, handler);
  return () => window.removeEventListener(LOCATION_CHANGE_EVENT, handler);
}
