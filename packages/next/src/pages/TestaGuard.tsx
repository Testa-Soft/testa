/**
 * `<TestaGuard/>` — the anti-flicker shield for the PAGES ROUTER.
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
 * WHY THIS EXISTS, when `<TestaProvider/>` already auto-shields: the provider
 * raises its shield from a `useLayoutEffect`, which cannot run until React has
 * mounted. In the Pages Router the server ships complete HTML, so the browser
 * paints the CONTROL content during hydration — before any effect runs. The
 * shield arrives too late and the visitor sees the flash. Only markup inside
 * `<head>`, evaluated while the document is still parsing, can hide content
 * before that first paint. That is this component: an inline `<style>`-raising
 * IIFE, the same snippet `@testa-soft/dom` exposes for hand-rolled setups.
 *
 * It composes with the provider rather than duplicating it — `raiseShield` is
 * idempotent by `styleId`, so the provider finds the shield already up and
 * simply reveals it once the variant is applied.
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
