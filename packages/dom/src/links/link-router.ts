/**
 * Client-side routing for links an experiment injected.
 *
 * Markup arrives through innerHTML / insertAdjacentHTML, so a link in it is a
 * plain `<a href>` — not the app's `<Link>`. On a Next.js or React SPA a click
 * on it reloads the whole document: the app re-boots, state is lost, and the
 * visitor waits on a full page load the app's own links never pay for.
 *
 * `installLinkRouter(navigate)` closes that gap with ONE delegated listener.
 * It routes a click through `navigate` (the host's router) only when the link:
 *   - sits inside a node an applier injected (see `apply/injected.ts`) — the
 *     app's own links are never touched;
 *   - is same-origin http(s), and leads to a different page — `#hash` jumps,
 *     `href="#"` (the classic "dismiss" link) and `href=""` stay with the
 *     browser, where a router would turn them into a pointless re-navigation;
 *   - is a plain primary click — no modifier key, so cmd/ctrl-click still opens
 *     a new tab — with no `target` other than `_self` and no `download`;
 *   - was not already cancelled by someone else (the variation's own `js`, the
 *     app, or a second installed router).
 * Anything else falls through to the browser, untouched.
 *
 * The listener sits on `window` in the bubble phase — the last stop — so any
 * handler on the link or the document gets to cancel the click first.
 */

import { isInsideInjected } from '../apply/injected.ts';

/** Navigate the host app to a same-origin path (`/path?query#hash`). */
export type Navigate = (href: string) => void;

/**
 * History-API navigation: push the URL, then fire `popstate` so a router that
 * listens for it (React Router's `BrowserRouter`, TanStack Router) renders the
 * new route. OPT-IN only — never a default: on a page whose router does not
 * route on `popstate` (a `HashRouter`, React widgets on a multi-page site, a
 * same-origin path the SPA doesn't own) the URL changes and the page doesn't.
 */
export function historyNavigate(href: string): void {
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

/** Install the delegated click router. Returns an idempotent uninstall. */
export function installLinkRouter(navigate: Navigate): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onClick = (event: MouseEvent): void => {
    const href = routableHref(event);
    if (href === null) return;
    event.preventDefault();
    try {
      navigate(href);
    } catch (err) {
      // A router that isn't ready (or rejects the path) must not swallow the
      // click — the visitor still gets where the link points, just slower.
      console.error('[testa] client-side navigation failed, reloading instead:', err);
      window.location.assign(href);
    }
  };

  window.addEventListener('click', onClick);
  return () => window.removeEventListener('click', onClick);
}

/**
 * The path to route `event` to, or `null` when the click belongs to the
 * browser (see the rules in the file header).
 */
function routableHref(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const target = event.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (!isInsideInjected(anchor)) return null;

  const frame = anchor.getAttribute('target');
  if (frame && frame !== '_self') return null;
  if (anchor.hasAttribute('download')) return null;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const here = window.location;
  if (url.pathname === here.pathname && url.search === here.search) return null;

  return url.pathname + url.search + url.hash;
}
