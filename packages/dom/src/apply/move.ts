/**
 * crobot `move_element_append` / `move_element_prepend` changes: relocate each
 * matching element (`selector`) under a target element (`content` = target
 * selector).
 *
 *  - move_element_append  → `target.appendChild(el)` (moves el to end of target)
 *  - move_element_prepend → `target.prepend(el)`     (moves el to start of target)
 *
 * `appendChild`/`prepend` MOVE the node (detach from its current parent),
 * matching legacy behaviour. If the target is missing, the move is a no-op for
 * that element (mirrors legacy's `if (parent)` guard). Watches the DOM through
 * `eachMatching` and returns a teardown; the WeakSet dedupe moves each once.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { type EachMatchingOptions, eachMatching } from './dom.ts';

export type MoveChange = Extract<
  VariationChange,
  { type: 'move_element_append' | 'move_element_prepend' }
>;

export function applyMove(change: MoveChange, opts: EachMatchingOptions = {}): () => void {
  const position = change.type === 'move_element_append' ? 'append' : 'prepend';
  return eachMatching(
    change.selector,
    (el) => {
      const target = safeQuerySelector(change.content);
      if (!target) return; // Target not on the page (yet) — skip, like legacy.
      if (position === 'append') {
        target.appendChild(el);
      } else {
        target.prepend(el);
      }
    },
    opts,
  );
}

/** Single-match lookup that swallows malformed selectors, like dom.ts helpers. */
function safeQuerySelector(selector: string): Element | null {
  if (typeof document === 'undefined') return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}
