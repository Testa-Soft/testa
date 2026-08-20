/**
 * `<TestaShield/>` — the anti-flicker shield as a React Server Component.
 *
 * Unlike the client-entry shield (which always renders), this one is SELF-GATING:
 * it renders the inline `<head>` script ONLY when the middleware signals a pending
 * DOM change for THIS request (the `x-testa-shield: '1'` request header, computed
 * per-page via `hasPendingDomChange`). So split-URL-only pages/projects — and any
 * page with nothing to mutate — never get shielded, and no shield is left hanging
 * for `<TestaExperiments/>` to reveal.
 *
 * It reads the header via `next/headers`. `await headers()` works on both Next 14
 * (sync value) and Next 15/16 (promise). Outside a request scope (static
 * generation) `headers()` throws — we catch and render nothing (fail open, no
 * shield), which is correct: a statically rendered page has no per-visitor DOM
 * change to hide.
 */

import { type ShieldOptions, buildShieldSnippet } from '@testa-soft/dom';
import { headers } from 'next/headers';
import { SHIELD_HEADER } from '../constants.ts';

export type TestaShieldProps = ShieldOptions;

export async function TestaShield(props: TestaShieldProps): Promise<JSX.Element | null> {
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
