/**
 * crobot `append_html` / `prepend_html` changes: inject `content` relative to
 * each matching element via `insertAdjacentHTML`.
 *
 *  - append_html  → `insertAdjacentHTML('beforeend', content)`  (inside, at end)
 *  - prepend_html → `insertAdjacentHTML('afterbegin', content)` (inside, at start)
 *
 * Watches the DOM through `eachMatching` (current + late-rendered matches) and
 * returns a teardown. The WeakSet in `eachMatching` dedupes, so each element is
 * inserted into exactly once. `<script>` is stripped like `applyChangeHtml`.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { eachMatching } from './dom.ts';
import { stripScriptTags } from './html.ts';

export type AppendChange = Extract<VariationChange, { type: 'append_html' }>;
export type PrependChange = Extract<VariationChange, { type: 'prepend_html' }>;

export function applyAppend(change: AppendChange): () => void {
  const sanitized = stripScriptTags(change.content);
  return eachMatching(change.selector, (el) => {
    el.insertAdjacentHTML('beforeend', sanitized);
  });
}

export function applyPrepend(change: PrependChange): () => void {
  const sanitized = stripScriptTags(change.content);
  return eachMatching(change.selector, (el) => {
    el.insertAdjacentHTML('afterbegin', sanitized);
  });
}
