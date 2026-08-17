/**
 * crobot `hide_element` change: set `display:none` on each matching element.
 *
 * Watches the DOM via `eachMatching`, so elements that render AFTER apply (SPA /
 * late React render) are hidden too — the modern equivalent of 3.3.3's
 * `setTimeout` retry loop. Returns a teardown that disconnects the observer; the
 * caller disposes it on the next cycle.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { eachMatching } from './dom.ts';

export type HideChange = Extract<VariationChange, { type: 'hide_element' }>;

export function applyHide(change: HideChange): () => void {
  return eachMatching(change.selector, (el) => {
    if (el instanceof HTMLElement) {
      el.style.display = 'none';
    }
  });
}
