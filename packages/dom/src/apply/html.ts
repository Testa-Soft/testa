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
import { type EachMatchingOptions, eachMatching } from './dom.ts';

export type ChangeHtmlChange = Extract<VariationChange, { type: 'change_html' }>;

export function applyChangeHtml(
  change: ChangeHtmlChange,
  opts: EachMatchingOptions = {},
): () => void {
  const sanitized = stripScriptTags(change.content);
  const guard = opts.guard;
  // Original innerHTML per touched element, so teardown can UNDO the change.
  // Needed because (a) persistent-layout elements never re-mount on soft nav —
  // React won't reset a mutation it doesn't know about — and (b) the observer
  // can hit the next page's element before the caller's cleanup runs.
  const originals = new Map<Element, string>();

  const stop = eachMatching(
    change.selector,
    (el) => {
      if (!originals.has(el)) originals.set(el, el.innerHTML);
      el.innerHTML = sanitized;
    },
    opts,
  );

  // KEEPER — re-assert on framework clobber. React reconciliation REUSES a
  // matched element across renders/route-changes and rewrites its text
  // (`textContent`), silently erasing the change. The new-match observer in
  // `eachMatching` can't help: no Element is added, and the element is already
  // `seen`. So a second observer watches for content drift on the elements we
  // changed and re-asserts — adopting the framework's newest content as the
  // restore target first, so a later teardown restores what the app would have
  // shown NOW (not a stale pre-apply capture). Re-asserting our own write is a
  // no-op (content already equals `sanitized`), so there is no observer loop.
  // No timeout: unlike late-match discovery, keeping N known elements asserted
  // is cheap, and a re-render can clobber at any time — lives until teardown.
  let keeper: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    keeper = new MutationObserver(() => {
      for (const el of originals.keys()) {
        if (!el.isConnected) continue;
        if (el.innerHTML === sanitized) continue;
        if (guard && !guard()) continue; // off-page: the app's content stands
        originals.set(el, el.innerHTML);
        el.innerHTML = sanitized;
      }
    });
    keeper.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  return () => {
    stop();
    keeper?.disconnect();
    for (const [el, original] of originals) {
      // Restore ONLY if our content is still there — if React re-rendered the
      // node meanwhile, the change is already gone and we must not stomp it.
      if (el.innerHTML === sanitized) el.innerHTML = original;
    }
    originals.clear();
  };
}

/**
 * Strip `<script>...</script>` (any case/attributes) from the HTML. A regex is
 * sufficient — a defense-in-depth measure on top of the browser's own innerHTML
 * behaviour, not the only line of defense.
 */
export function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
