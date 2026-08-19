/**
 * `@testa-soft/dom` — the browser render layer for experiments.
 *
 * Pairs with `experiment-core` (the host-neutral decision layer): core decides
 * WHICH variation a visitor gets; this package RENDERS it in the DOM. Shared by
 * the standalone pixel, the `@testa/next` client component, and any future
 * client SDK, so every surface applies variations identically.
 *
 * Change shapes are crobot-native (`shared-types` `VariationChange`):
 * `change_html`, `css`, `hide_element`, `append_html`, `prepend_html`,
 * `move_element_append`, `move_element_prepend` — same names + `content` field
 * crobot authors, so there's no adapter between authoring and apply.
 *
 * v1 surface:
 *   - `applyVariation` — walk a variation's `change[]` and mutate the DOM;
 *     returns teardowns for the DOM-watching appliers (caller disposes them on
 *     the next experiment cycle). Late-rendered elements are handled by a
 *     MutationObserver with a timeout fallback (3.3.3 retry-loop parity, no
 *     polling — see `apply/dom.ts`).
 *   - `raiseShield` / `buildShieldSnippet` — anti-flicker: hide content until
 *     the variation is applied, with a hard timeout fallback.
 */

export {
  raiseShield,
  buildShieldSnippet,
  DEFAULT_SHIELD_STYLE_ID,
} from './shield/shield.ts';
export type { Shield, ShieldOptions, ShieldMode } from './shield/shield.ts';
export { applyVariation } from './apply/index.ts';
export type { Teardown } from './apply/index.ts';
export {
  applyAppend,
  applyChangeHtml,
  applyCss,
  applyHide,
  applyMove,
  applyPrepend,
} from './apply/index.ts';
export { eachMatching, safeQuerySelectorAll } from './apply/dom.ts';
export { stripScriptTags } from './apply/html.ts';
export {
  testa,
  onVariationApplied,
  onVariationAssigned,
  emitVariationApplied,
  emitVariationAssigned,
  installTestaGlobal,
} from './events/bus.ts';
export type {
  VariationEvent,
  VariationEventName,
  VariationHandler,
  Unsubscribe,
  TestaGlobal,
} from './events/bus.ts';
