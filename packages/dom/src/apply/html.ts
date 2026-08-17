/**
 * crobot `change_html` change: replace `el.innerHTML` with `content` for every
 * match (current + late-rendered). crobot uses this for both copy and markup
 * changes — `content` is treated as HTML.
 *
 * `<script>` tags are stripped (defense-in-depth): a script inside innerHTML
 * doesn't execute anyway, but stripping keeps behaviour predictable. `<iframe>`/
 * `<object>`/`<embed>` are NOT stripped (customers embed YouTube etc.).
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { eachMatching } from './dom.ts';

export type ChangeHtmlChange = Extract<VariationChange, { type: 'change_html' }>;

export function applyChangeHtml(change: ChangeHtmlChange): () => void {
  const sanitized = stripScriptTags(change.content);
  return eachMatching(change.selector, (el) => {
    el.innerHTML = sanitized;
  });
}

/**
 * Strip `<script>...</script>` (any case/attributes) from the HTML. A regex is
 * sufficient — a defense-in-depth measure on top of the browser's own innerHTML
 * behaviour, not the only line of defense.
 */
export function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
