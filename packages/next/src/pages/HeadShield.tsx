/**
 * The Pages Router anti-flicker shield, ON BY DEFAULT — no `_document.tsx`, no
 * wiring. `<TestaProvider/>` renders this, and it puts a JS-free `<style>` in
 * the document `<head>` through `next/head`, which the Pages Router renders on
 * the SERVER. That timing is the whole point:
 *
 *   server HTML (shield already in <head>) → nothing paints → bundle → hydrate
 *   → config → variant applied → shield unrendered → first paint IS the variant.
 *
 * A client-side shield cannot do this. `raiseShield` from an effect runs after
 * the browser has already painted the server-rendered control content, so it
 * turns one flash into two: content → blank → variant. Only markup that exists
 * before the body paints prevents the flash, and in the Pages Router only the
 * server can produce it.
 *
 * Reveal is `settled` from the provider's context (variant applied, or nothing
 * to apply, or failed open) — this component simply stops rendering the style,
 * and removes the server-rendered element directly rather than trusting
 * `next/head`'s reconciliation with a tag that decides whether the site is
 * visible. If the JavaScript never arrives at all, the CSS reveals itself at
 * `timeoutMs` (see `buildShieldCss`), so a broken bundle can't hide a site.
 *
 * `<TestaGuard/>` (in `_document.tsx`) stays worth adding — not for the shield
 * any more, but because it also starts the CONFIG FETCH in `<head>`, which is
 * what shortens the hidden window from "after hydration" to "during parse".
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { SHIELD_CSS_STYLE_ID, type ShieldOptions, buildShieldCss } from '@testa-soft/dom';
import { useTestaSettled } from '@testa-soft/react';
import { useRouter } from 'next/compat/router.js';
// compat/router returns null instead of throwing when no Pages Router is
// mounted, so this stays a no-op if the /pages provider is used in the App
// Router by mistake — `next/head` has no effect there.
import Head from 'next/head.js';
import { type JSX, useEffect } from 'react';
import { shouldRenderHeadShield } from './shield-decision.ts';

export interface HeadShieldProps {
  /**
   * Same knob as `<TestaProvider shield>`: `false` opts out entirely, an object
   * customises the hide (`selector`, `timeoutMs`, `mode`).
   */
  shield?: boolean | ShieldOptions;
  /**
   * The inline config, when the app passes one. Known at render time, so we can
   * skip shielding a project that has nothing to hide instead of hiding the page
   * for no reason. With only a `projectId` the config isn't there yet at first
   * paint — which is exactly when the decision must be made — so we shield.
   */
  config?: ProjectConfig;
}

/** Drop the server-rendered shield element, whoever still holds a reference. */
function removeShieldStyle(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(SHIELD_CSS_STYLE_ID)?.remove();
}

export function HeadShield({ shield, config }: HeadShieldProps): JSX.Element | null {
  const settled = useTestaSettled();
  const router = useRouter();
  const render = shouldRenderHeadShield({
    ...(shield !== undefined ? { shield } : {}),
    ...(config ? { config } : {}),
    hasPagesRouter: !!router,
    settled,
  });

  useEffect(() => {
    if (!render) removeShieldStyle();
  }, [render]);

  if (!render) return null;

  const css = buildShieldCss(typeof shield === 'object' ? shield : {});
  // Built from author-controlled shield options; contains no untrusted input.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: inlining our own shield CSS by design
  const style = <style id={SHIELD_CSS_STYLE_ID} dangerouslySetInnerHTML={{ __html: css }} />;
  return <Head>{style}</Head>;
}
