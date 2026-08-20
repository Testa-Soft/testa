/**
 * `<TestaGuard/>` — the anti-flicker shield, as an inline `<head>` script.
 *
 * DOM experiments mutate server-rendered (control) content, so without shielding
 * there's a control→variant flash. A React effect can't prevent it — it runs
 * after first paint. So this renders a synchronous inline script that hides the
 * content BEFORE the body paints, with a hard timeout fallback; `<TestaProvider/>`
 * reveals it once the variant is applied.
 *
 * Render it as high as possible in the root layout (ideally inside <head>). It's
 * plain markup (no `use client`) so it runs before hydration. Split-URL-only
 * deployments don't need it — the middleware's 307 is already flicker-free.
 */

import { type ShieldOptions, buildShieldSnippet } from '@testa-soft/dom';

export type TestaGuardProps = ShieldOptions;

export function TestaGuard(props: TestaGuardProps): JSX.Element {
  // The snippet is built from author-controlled options and JSON-encodes its
  // values; it contains no untrusted input.
  const snippet = buildShieldSnippet(props);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: inlining our own shield IIFE by design
  return <script dangerouslySetInnerHTML={{ __html: snippet }} />;
}
