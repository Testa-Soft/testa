/**
 * crobot `js` change: execute `content` as a script in page context.
 *
 * Why a change type at all: markup arrives through `innerHTML` /
 * `insertAdjacentHTML`, and a `<script>` tag inserted that way is inert by
 * spec — `applyChangeHtml` strips them outright rather than leave a tag that
 * looks like it ran. So an authored section had no way to carry behaviour.
 * This is that channel, and the only one: it is deliberately explicit, so a
 * change that executes code is visible as such in the payload.
 *
 * The script element is built fresh and its source set via `textContent`, which
 * is what makes it run (the browser executes a script node it parses from the
 * DOM API, unlike one assigned through `innerHTML`).
 *
 * Runs ONCE per apply cycle. The shield re-applies `change_html` after a
 * framework re-render, but re-running arbitrary script on every re-render would
 * double-bind listeners and re-trigger side effects, so this applier does not
 * participate. Authored code must therefore be idempotent and should delegate
 * from `document` rather than bind to nodes that may be replaced.
 */

import type { VariationChange } from '@testa-platform/shared-types';

export type JsChange = Extract<VariationChange, { type: 'js' }>;

const SCRIPT_ATTR = 'data-testa-js';

export interface ApplyJsOptions {
  /**
   * Page gate, checked immediately before execution — same contract as the
   * DOM appliers, so an off-page cycle never runs the script.
   */
  guard?: () => boolean;
}

/**
 * Execute a variation's JS. Idempotent per `(variationId, content)`: if this
 * exact script is already on the page, it is left alone rather than re-run.
 *
 * Returns a teardown that removes the script element. Removing a script does
 * NOT undo what it did — anything the script needs to clean up on a soft
 * navigation should be registered by the script itself.
 */
export function applyJs(
  variationId: number | string,
  change: JsChange,
  opts: ApplyJsOptions = {},
): () => void {
  if (typeof document === 'undefined') return () => {};
  if (opts.guard && !opts.guard()) return () => {};

  const id = `testa-js-${variationId}-${hashContent(change.content)}`;
  const existing = document.getElementById(id);
  if (existing) return () => existing.remove();

  const script = document.createElement('script');
  script.id = id;
  script.setAttribute(SCRIPT_ATTR, String(variationId));
  script.type = 'text/javascript';
  script.textContent = change.content;

  // Appended to <body>, not <head>: the variation's markup is already in the
  // document by the time appliers run, so the script sees the DOM it targets.
  (document.body ?? document.documentElement).appendChild(script);

  return () => script.remove();
}

/** Cheap hash so the script tag id is short + deterministic per content. */
function hashContent(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
