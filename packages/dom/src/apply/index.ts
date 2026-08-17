/**
 * Variation apply — composition root that walks a variation's `change[]` and
 * dispatches to the per-type appliers. Change shapes are crobot-native
 * (`@testa-platform/shared-types` `VariationChange`): the runtime consumes what
 * crobot authors, no adapter in between.
 *
 * Returns teardown functions for the appliers that watch the DOM; the caller
 * (the pixel's lifecycle / the `@testa/next` client) collects these and
 * disconnects the observers when the next cycle starts, so a SPA route change
 * doesn't leave stale watchers piling up.
 *
 * The `redirect` change (crobot `url`) is NOT applied here — the split-URL
 * redirect engine (experiment-core) runs BEFORE variation apply.
 */

import type { VariationChange } from '@testa-platform/shared-types';
import { type CssChange, applyCss } from './css.ts';
import { type HideChange, applyHide } from './hide.ts';
import { type ChangeHtmlChange, applyChangeHtml } from './html.ts';
import { type AppendChange, type PrependChange, applyAppend, applyPrepend } from './insert.ts';
import { type MoveChange, applyMove } from './move.ts';

export type Teardown = () => void;

/**
 * Apply every change for a variation. Returns teardowns for the DOM-watching
 * appliers; the caller disposes them on the next experiment cycle.
 */
export function applyVariation(
  variationId: number | string,
  changes: VariationChange[],
): Teardown[] {
  const teardowns: Teardown[] = [];
  for (const change of changes) {
    try {
      const teardown = applyOne(variationId, change);
      if (teardown) teardowns.push(teardown);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: applier failure must be visible but non-fatal
      console.error('[testa] applier threw:', err);
    }
  }
  return teardowns;
}

function applyOne(variationId: number | string, change: VariationChange): Teardown | null {
  switch (change.type) {
    case 'css':
      // CSS uses a global <style> tag — no DOM watcher, no teardown.
      applyCss(variationId, change as CssChange);
      return null;

    case 'change_html':
      return applyChangeHtml(change as ChangeHtmlChange);

    case 'hide_element':
      return applyHide(change as HideChange);

    case 'append_html':
      return applyAppend(change as AppendChange);

    case 'prepend_html':
      return applyPrepend(change as PrependChange);

    case 'move_element_append':
    case 'move_element_prepend':
      return applyMove(change as MoveChange);

    case 'redirect':
      // Split-URL redirect (crobot `url`) is the experiment-core engine's job.
      return null;
  }
}

export { applyCss } from './css.ts';
export { applyChangeHtml, stripScriptTags } from './html.ts';
export { applyHide } from './hide.ts';
export { applyAppend, applyPrepend } from './insert.ts';
export { applyMove } from './move.ts';
export { eachMatching, safeQuerySelectorAll } from './dom.ts';
