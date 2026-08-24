/**
 * `<TestaGuard/>` — the anti-flicker shield as a React Server Component.
 *
 * Unlike the client-entry shield (which always renders), this one is SELF-GATING:
 * it renders the inline `<head>` script ONLY when the middleware signals a pending
 * DOM change for THIS request (the `x-testa-shield: '1'` request header, computed
 * per-page via `hasPendingDomChange`). So split-URL-only pages/projects — and any
 * page with nothing to mutate — never get shielded, and no shield is left hanging
 * for `<TestaProvider/>` to reveal.
 *
 * It reads the header via `next/headers`. `await headers()` works on both Next 14
 * (sync value) and Next 15/16 (promise). Outside a request scope (static
 * generation) `headers()` throws — we catch and render nothing (fail open, no
 * shield), which is correct: a statically rendered page has no per-visitor DOM
 * change to hide.
 *
 * The `.js` in the specifier is REQUIRED, not cosmetic. `next` ships no `exports`
 * map (verified on 13.4 → 15.5), so a bare `next/headers` is resolved by Node's
 * ESM resolver as a plain file path — and ESM does not guess extensions, so it
 * fails with ERR_MODULE_NOT_FOUND ("Did you mean to import next/headers.js?").
 * A consumer's bundler hides this (webpack/turbopack do guess extensions), but
 * when the app puts us in `serverExternalPackages` /
 * `experimental.serverComponentsExternalPackages`, Node loads this file directly
 * and the bare specifier throws. Keep the extension on every `next/*` import in
 * this package.
 */

import { type ShieldOptions, buildShieldSnippet } from '@testa-soft/dom';
import { headers } from 'next/headers.js';
import { SHIELD_HEADER } from '../constants.ts';

export type TestaGuardProps = ShieldOptions;

export async function TestaGuard(props: TestaGuardProps): Promise<JSX.Element | null> {
  let shield: string | null = null;
  try {
    const h = await headers();
    shield = h.get(SHIELD_HEADER);
  } catch {
    // Outside a request scope (static generation) → no shield.
    return null;
  }

  if (shield !== '1') return null;

  // The snippet is built from author-controlled options and JSON-encodes its
  // values; it contains no untrusted input.
  const snippet = buildShieldSnippet(props);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: inlining our own shield IIFE by design
  return <script dangerouslySetInnerHTML={{ __html: snippet }} />;
}
