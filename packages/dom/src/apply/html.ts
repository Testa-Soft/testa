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
import { markInjected } from './injected.ts';

export type ChangeHtmlChange = Extract<VariationChange, { type: 'change_html' }>;

/**
 * The top-level nodes we injected, held weakly so they can be collected with
 * the document. This is how the keeper tells "the framework wiped our content"
 * from "the variation's own `js` change edited inside it". Comparing innerHTML
 * to the authored string cannot distinguish the two: an authored script that
 * animates a counter or rotates a word produces drift on every tick, and
 * re-asserting it fights the script forever — on a real page that is a write /
 * revert storm that locks up the tab.
 *
 * A WeakSet rather than a marker attribute: nothing we do should be visible in
 * the customer's DOM, where it could collide with their styles or assertions.
 */
const injected = new WeakSet<Element>();

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
      write(el, sanitized);
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
        if (stillApplied(el, sanitized)) continue;
        if (guard && !guard()) continue; // off-page: the app's content stands
        originals.set(el, el.innerHTML);
        write(el, sanitized);
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
      if (stillApplied(el, sanitized)) el.innerHTML = original;
    }
    originals.clear();
  };
}

/** Write the authored markup and remember the nodes it produced as ours. */
function write(el: Element, sanitized: string): void {
  el.innerHTML = sanitized;
  for (const child of Array.from(el.children)) {
    injected.add(child);
    markInjected(child);
  }
}

/**
 * Whether the element still holds the content we injected.
 *
 * Markup content is identified by the nodes we created still being there: that
 * survives any edit made INSIDE our subtree and stops holding the moment the
 * framework re-renders the element's children. Text-only content has no element
 * to mark, so it falls back to comparing against the authored string — which is
 * exactly right for a copy change, where any drift is the framework's doing.
 */
function stillApplied(el: Element, sanitized: string): boolean {
  for (const child of Array.from(el.children)) {
    if (injected.has(child)) return true;
  }

  return el.innerHTML === sanitized;
}

/**
 * Strip `<script>...</script>` (any case/attributes) from the HTML. A regex is
 * sufficient — a defense-in-depth measure on top of the browser's own innerHTML
 * behaviour, not the only line of defense.
 */
export function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
