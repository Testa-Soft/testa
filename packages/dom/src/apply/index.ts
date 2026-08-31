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

export interface ApplyVariationOptions {
  /**
   * Page gate, checked at the moment any node would be touched (initial sweep
   * AND late MutationObserver hits). The SPA document persists across soft
   * navigations, so callers pass "does the current URL still match this
   * experiment's page rule?" — off-page elements are never modified.
   */
  guard?: () => boolean;
}

/**
 * Apply every change for a variation. Returns teardowns for the DOM-watching
 * appliers; the caller disposes them on the next experiment cycle. Teardowns
 * UNDO what was applied (restore innerHTML/display, remove style/inserted
 * nodes) so a soft navigation away leaves no trace on persistent elements.
 */
export function applyVariation(
  variationId: number | string,
  changes: VariationChange[],
  opts: ApplyVariationOptions = {},
): Teardown[] {
  const teardowns: Teardown[] = [];
  for (const change of changes) {
    try {
      const teardown = applyOne(variationId, change, opts);
      if (teardown) teardowns.push(teardown);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: applier failure must be visible but non-fatal
      console.error('[testa] applier threw:', err);
    }
  }
  return teardowns;
}

function applyOne(
  variationId: number | string,
  change: VariationChange,
  opts: ApplyVariationOptions,
): Teardown | null {
  const guardOpts = opts.guard ? { guard: opts.guard } : {};
  switch (change.type) {
    case 'css':
      // Global <style> tag: gate at apply time (no watcher), removable teardown.
      if (opts.guard && !opts.guard()) return null;
      return applyCss(variationId, change as CssChange);

    case 'change_html':
      return applyChangeHtml(change as ChangeHtmlChange, guardOpts);

    case 'hide_element':
      return applyHide(change as HideChange, guardOpts);

    case 'append_html':
      return applyAppend(change as AppendChange, guardOpts);

    case 'prepend_html':
      return applyPrepend(change as PrependChange, guardOpts);

    case 'move_element_append':
    case 'move_element_prepend':
      return applyMove(change as MoveChange, guardOpts);

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
export { LATE_MATCH_WINDOW_MS, eachMatching, safeQuerySelectorAll } from './dom.ts';
