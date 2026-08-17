/**
 * crobot `css` change: inject `content` verbatim as a global `<style>` tag.
 *
 * crobot authors CSS as a raw stylesheet string (`#hero { color: red }`), so we
 * inject it as-is — no per-selector styles map. A global `<style>` (vs inline
 * `el.style`):
 *   - survives DOM re-renders (React replaces nodes; inline styles vanish);
 *   - is idempotent — re-applying overwrites the same tag instead of stacking.
 *
 * `content` is set via `textContent` (not innerHTML), so a stray `</style>` in
 * the CSS can't break out into HTML — the browser treats the tag's text as CSS.
 */

import type { VariationChange } from '@testa-platform/shared-types';

export type CssChange = Extract<VariationChange, { type: 'css' }>;

const STYLE_ID_PREFIX = 'testa-css-';

/**
 * Apply a CSS variation. Idempotent: re-running with the same `(variationId,
 * content)` overwrites the existing `<style>` tag instead of stacking. The
 * `variationId` is in the tag id so multiple variations on one page don't
 * clobber each other.
 */
export function applyCss(variationId: number | string, change: CssChange): void {
  if (typeof document === 'undefined') return;
  const id = `${STYLE_ID_PREFIX}${variationId}-${hashContent(change.content)}`;
  const existing = document.getElementById(id);

  if (existing instanceof HTMLStyleElement) {
    existing.textContent = change.content;
    return;
  }

  const style = document.createElement('style');
  style.id = id;
  style.setAttribute('data-testa-css', String(variationId));
  style.textContent = change.content;
  document.head.appendChild(style);
}

/** Cheap hash so the style tag id is short + deterministic per content. */
function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
