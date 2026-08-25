/**
 * `<TestaGuard/>` — OPTIONAL head-time acceleration for the PAGES ROUTER.
 *
 * The shield itself no longer needs this: `<TestaProvider/>` server-renders one
 * by default through `next/head` (see `HeadShield.tsx`). What this adds is the
 * CONFIG FETCH, started while the HTML is still parsing instead of after the
 * bundle has hydrated — which is what shortens the shielded window, since the
 * page stays hidden until the config lands. Add it if you care about that (and
 * for a second, script-based shield with its own JS timeout).
 *
 * Goes in `pages/_document.tsx`, inside `<Head>`:
 *
 *   import { Head, Html, Main, NextScript } from 'next/document';
 *   import { TestaGuard } from '@testa-soft/next/pages';
 *
 *   export default function Document() {
 *     return (
 *       <Html lang="en">
 *         <Head><TestaGuard /></Head>
 *         <body><Main /><NextScript /></body>
 *       </Html>
 *     );
 *   }
 *
 * It composes with the provider's shield rather than fighting it: the two use
 * different style ids and each is released by its owner when the variant is
 * applied — this one by `<TestaProvider/>` calling `window.__testa_shield`'s
 * reveal, the provider's own by unrendering it.
 *
 * Unlike the App Router's `<TestaGuard/>` (`@testa-soft/next/server`) this one
 * is NOT gated on the middleware's `x-testa-shield` header: `_document` renders
 * at BUILD time for statically optimized pages, where no request header exists.
 * It therefore shields every page load and relies on `timeoutMs` (default 4s)
 * plus the provider's reveal. On a project with nothing to hide that costs a
 * brief invisible paint, which is why `<TestaProvider/>` should always be
 * mounted alongside it — it reveals as soon as the config settles, including
 * when the config fails to load.
 */

import { type ShieldOptions, buildConfigPreloadSnippet, buildShieldSnippet } from '@testa-soft/dom';
import type { JSX } from 'react';
import { buildConfigUrl } from '../config-fetch.ts';

export interface TestaGuardProps extends ShieldOptions {
  /**
   * Project id. Pass it to also START THE CONFIG FETCH here, in `<head>`,
   * while the HTML is still parsing — rather than after the bundle has
   * downloaded and hydrated far enough to render `<TestaProvider/>`. The
   * provider adopts the in-flight request instead of issuing its own, so this
   * is a head start, not a second fetch. Strongly recommended: everything the
   * client decides — DOM applies, and the split-URL redirect when the server
   * instance was cold — is waiting on this response.
   */
  projectId?: string;
  /** Config host override for the head-time fetch. Defaults to the built-in host. */
  host?: string;
}

export function TestaGuard({ projectId, host, ...shield }: TestaGuardProps): JSX.Element {
  // Both snippets are built from author-controlled options which the builders
  // JSON-encode; neither contains untrusted input.
  const snippet = projectId
    ? buildConfigPreloadSnippet({ url: buildConfigUrl(host ?? '', projectId) }) +
      buildShieldSnippet(shield)
    : buildShieldSnippet(shield);
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: inlining our own shield IIFE by design
    <script dangerouslySetInnerHTML={{ __html: snippet }} />
  );
}
