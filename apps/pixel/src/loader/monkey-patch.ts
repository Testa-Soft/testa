/**
 * History API monkey-patch — earliest possible installation point so we
 * catch every SPA navigation, including the ones a framework's router does
 * during its own hydration phase.
 *
 * Patch design (from `docs/architecture/01-tracker.md` § SPA navigation):
 *
 *   1. Idempotent — guarded by `window._testa_patched_v4` so a double-loaded
 *      pixel doesn't re-wrap the wrapper.
 *   2. Calls the original FIRST (so the framework's state advances normally).
 *   3. Queues a microtask AFTER the original returns; the microtask dispatches
 *      `_testa:locationchange` CustomEvent. This ordering means downstream
 *      handlers see the framework's updated router state, fixing the Next.js
 *      query-param race the user reported.
 *   4. `popstate` and `hashchange` listeners feed into the same dispatch.
 *   5. `pageshow` re-installs the patch if bfcache restored the original
 *      references (Safari sometimes hands them back live).
 *
 * Out of scope here: the listener side (debounce, canonical-URL diff, re-eval).
 * That lives in `runtime/spa.ts` (Phase 3.5). This file just emits the event.
 */

const PATCH_FLAG = '_testa_patched_v4' as const;
const LOCATIONCHANGE_EVENT = '_testa:locationchange' as const;

type HistoryFn = (data: unknown, unused: string, url?: string | URL | null) => void;

interface PatchedWindow extends Window {
  [PATCH_FLAG]?: boolean;
}

export function installMonkeyPatch(): void {
  const w = window as PatchedWindow;
  if (w[PATCH_FLAG]) return;

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  window.addEventListener('popstate', dispatchLocationChange);
  window.addEventListener('hashchange', dispatchLocationChange);

  // bfcache restore can hand back the original `history.pushState` reference,
  // unwrapping our patch. Re-check on every pageshow.
  window.addEventListener('pageshow', () => {
    if (!w[PATCH_FLAG]) installMonkeyPatch();
  });

  w[PATCH_FLAG] = true;
}

function patchHistoryMethod(name: 'pushState' | 'replaceState'): void {
  // An accessor, not a frozen value: Next.js' App Router (and others) assign
  // their own `history.pushState = …` in strict mode, and a non-writable
  // property makes that assignment THROW, which takes the whole app down.
  // Whatever a framework assigns is wrapped again, so it cannot unwrap us and
  // the event still fires after its function returns.
  let current = wrap(history[name] as HistoryFn);

  try {
    Object.defineProperty(history, name, {
      get: () => current,
      set: (next: unknown) => {
        if (typeof next === 'function') current = wrap(next as HistoryFn);
      },
      configurable: true,
      enumerable: false,
    });
  } catch {
    // If defineProperty fails (some sandboxed environments), fall back to
    // direct assignment. Loses the "framework can't unwrap" guarantee but
    // still delivers the event.
    (history as unknown as Record<string, HistoryFn>)[name] = current;
  }
}

function wrap(original: HistoryFn): HistoryFn {
  return function (this: History, ...args) {
    const result = original.apply(this, args as Parameters<HistoryFn>);
    // Schedule as microtask so the framework's reducer / hydration code that
    // follows the pushState() call gets to update its router state first.
    scheduleLocationChange();
    return result;
  };
}

let scheduled = false;

/** One event per tick: a framework wrapper that calls ours would otherwise fire it twice. */
function scheduleLocationChange(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    dispatchLocationChange();
  });
}

function dispatchLocationChange(): void {
  // CustomEvent works in every browser we support (IE not on the list).
  window.dispatchEvent(new CustomEvent(LOCATIONCHANGE_EVENT));
}

/** Exported for tests. */
export { LOCATIONCHANGE_EVENT, PATCH_FLAG };
