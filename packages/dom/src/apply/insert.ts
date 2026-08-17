/**
 * crobot `append_html` / `prepend_html` changes: inject `content` relative to
 * each matching element via `insertAdjacentHTML`.
 *
 *  - append_html  → `insertAdjacentHTML('beforeend', content)`  (inside, at end)
 *  - prepend_html → `insertAdjacentHTML('afterbegin', content)` (inside, at start)
 *
 * Watches the DOM through `eachMatching` (current + late-rendered matches). The
 * WeakSet in `eachMatching` dedupes within one apply, so each element is
 * inserted into once. Unlike the other changes, insert is NOT idempotent across
 * re-applies (each call adds nodes), so the returned teardown REMOVES exactly the
 * nodes this call inserted — the caller runs it before re-applying (React effect
 * cleanup, SPA cycle), so re-running never stacks duplicate nodes. `<script>` is
 * stripped like `applyChangeHtml`.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { eachMatching } from './dom.ts';
import { stripScriptTags } from './html.ts';

export type AppendChange = Extract<VariationChange, { type: 'append_html' }>;
export type PrependChange = Extract<VariationChange, { type: 'prepend_html' }>;

type InsertPosition = 'beforeend' | 'afterbegin';

function applyInsert(selector: string, content: string, position: InsertPosition): () => void {
  const sanitized = stripScriptTags(content);
  /** Every node this apply inserted, so teardown can remove exactly them. */
  const inserted: ChildNode[] = [];

  const stop = eachMatching(selector, (el) => {
    const before = new Set(el.childNodes);
    el.insertAdjacentHTML(position, sanitized);
    for (const node of el.childNodes) {
      if (!before.has(node)) inserted.push(node);
    }
  });

  return () => {
    stop();
    for (const node of inserted) node.remove();
    inserted.length = 0;
  };
}

export function applyAppend(change: AppendChange): () => void {
  return applyInsert(change.selector, change.content, 'beforeend');
}

export function applyPrepend(change: PrependChange): () => void {
  return applyInsert(change.selector, change.content, 'afterbegin');
}
