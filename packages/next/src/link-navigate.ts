/**
 * Adapts a Next router's `push` to `@testa-soft/dom`'s link router, so a link
 * inside experiment-injected markup navigates like a `<Link>` instead of
 * reloading the document. Shared by the App Router (`next/navigation`) and the
 * Pages Router (`next/router`) providers.
 *
 * `basePath`: an authored href is a real URL path, so it includes the app's
 * `basePath` — but `router.push` prepends basePath itself, so it is stripped
 * first (`/shop/pricing` → `/pricing`). A path outside basePath belongs to a
 * different app on the same origin; Next's router can't render it, so it gets
 * a normal document navigation.
 */

import type { Navigate } from '@testa-soft/dom';

export function nextLinkNavigate(push: (href: string) => unknown, basePath = ''): Navigate {
  return (href) => {
    const path = stripBasePath(href, basePath);
    if (path === null) {
      window.location.assign(href);
      return;
    }
    const result = push(path);
    // Pages Router `push` returns a promise. It rejects with `cancelled: true`
    // when a newer navigation supersedes this one — routine. Anything else is
    // worth a log line; Next itself falls back to a hard navigation on
    // load failures, so there is nothing for us to retry.
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        if ((err as { cancelled?: boolean } | null)?.cancelled) return;
        console.error('[testa] client-side navigation failed:', err);
      });
    }
  };
}

/**
 * The app's `basePath`, as Next inlines it into client bundles — the same
 * value Next's own router reads, so App Router apps need no prop for it.
 * Empty outside a Next build (no basePath, or `process` absent).
 */
export function readNextBasePath(): string {
  try {
    return process.env.__NEXT_ROUTER_BASEPATH ?? '';
  } catch {
    return '';
  }
}

/** `href` relative to `basePath`, or `null` when it lies outside it. */
function stripBasePath(href: string, basePath: string): string | null {
  if (!basePath) return href;
  if (!href.startsWith(basePath)) return null;
  const rest = href.slice(basePath.length);
  if (rest === '') return '/';
  if (rest.startsWith('/')) return rest;
  if (rest.startsWith('?') || rest.startsWith('#')) return `/${rest}`;
  return null; // `/shopping` under basePath `/shop` — a different path
}
