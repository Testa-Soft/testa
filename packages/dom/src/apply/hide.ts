/**
 * crobot `hide_element` change: set `display:none` on each matching element.
 *
 * Watches the DOM via `eachMatching`, so elements that render AFTER apply (SPA /
 * late React render) are hidden too — the modern equivalent of 3.3.3's
 * `setTimeout` retry loop. Returns a teardown that disconnects the observer; the
 * caller disposes it on the next cycle.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { type EachMatchingOptions, eachMatching } from './dom.ts';

export type HideChange = Extract<VariationChange, { type: 'hide_element' }>;

export function applyHide(change: HideChange, opts: EachMatchingOptions = {}): () => void {
  // Prior inline display per element, so teardown restores what we overwrote
  // (persistent-layout elements never re-mount, so nothing else would).
  const priors = new Map<HTMLElement, string>();

  const stop = eachMatching(
    change.selector,
    (el) => {
      if (el instanceof HTMLElement) {
        if (!priors.has(el)) priors.set(el, el.style.display);
        el.style.display = 'none';
      }
    },
    opts,
  );

  return () => {
    stop();
    for (const [el, prior] of priors) {
      // Restore only if we're still the ones hiding it.
      if (el.style.display === 'none') el.style.display = prior;
    }
    priors.clear();
  };
}
