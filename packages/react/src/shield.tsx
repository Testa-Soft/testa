/**
 * `<TestaShield/>` — the anti-flicker shield, as an inline `<script>`.
 *
 * DOM experiments mutate already-rendered (control) content, so without
 * shielding there's a control→variant flash. This renders a synchronous inline
 * script (via `buildShieldSnippet`) that hides the content with a hard timeout
 * fallback; `<TestaProvider/>` reveals it once the variant is applied.
 *
 * In a pure Vite SPA, place it as high as possible (ideally in `index.html`'s
 * `<head>` — you can inline `buildShieldSnippet()` there directly — or at the top
 * of your root component). Split-URL-only setups don't need it: the client
 * `location.replace` happens before the destination renders.
 */

import { type ShieldOptions, buildShieldSnippet, raiseShield } from '@testa-soft/dom';

export type TestaShieldProps = ShieldOptions;

export function TestaShield(props: TestaShieldProps): JSX.Element {
  // The snippet is built from author-controlled options and JSON-encodes its
  // values; it contains no untrusted input.
  const snippet = buildShieldSnippet(props);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: inlining our own shield IIFE by design
  return <script dangerouslySetInnerHTML={{ __html: snippet }} />;
}

export { raiseShield };
