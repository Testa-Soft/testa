/**
 * DOM helpers shared by every applier.
 *
 *  - `eachMatching(selector, fn)` runs `fn` on every match now AND every match
 *    that appears later (a MutationObserver auto-disconnects on first match).
 *    Late-arriving variants are how we apply CSS to a `.buy-button` that
 *    React hasn't rendered yet.
 *
 *  - `opts.guard` is checked at the moment a node would be touched (initial
 *    sweep AND observer hits). In an SPA the document persists across soft
 *    navigations, so an un-guarded watcher would apply the variant to the NEXT
 *    page's matching element — the caller passes "does the current URL still
 *    match this experiment's page rule?" and off-page nodes stay untouched.
 *
 *  - `safeQuerySelectorAll` swallows malformed selectors. Customers can paste
 *    nearly anything into the admin UI; we should refuse to crash on `.foo[`.
 */

/**
 * How long the late-match observer keeps looking for elements that hadn't
 * rendered when the variation was applied — the budget we give a framework to
 * paint its components. After it lapses, discovery stops: a NEW apply cycle
 * (re-bucketed on navigation, see the pixel lifecycle) is what puts changes
 * back, not a watcher lingering for the rest of the session.
 */
export const LATE_MATCH_WINDOW_MS = 2_000;

export interface EachMatchingOptions {
  /** Observer lifetime (ms) for late-rendered matches. Default 2s. */
  timeoutMs?: number;
  /**
   * Checked immediately before EVERY application (existing and late nodes).
   * Return false to skip — the node is NOT marked seen, so a later hit while
   * the guard passes can still apply within this cycle.
   */
  guard?: () => boolean;
}

/** Run `fn` on every current and future match for `selector`, capped by timeout (2s). */
export function eachMatching(
  selector: string,
  fn: (el: Element) => void,
  opts: EachMatchingOptions = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? LATE_MATCH_WINDOW_MS;
  const guard = opts.guard;
  const seen = new WeakSet<Element>();

  const tryApply = (root: ParentNode): void => {
    for (const el of safeQuerySelectorAll(root, selector)) {
      if (seen.has(el)) continue;
      if (guard && !guard()) return; // off-page: touch nothing, stay unseen
      seen.add(el);
      try {
        fn(el);
      } catch {
        // A throwing applier shouldn't abort the cycle; just skip this node.
      }
    }
  };

  // Apply against existing DOM.
  if (typeof document !== 'undefined' && document.body) {
    tryApply(document);
  }

  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  // Watch for late-rendered nodes.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) {
          // The added node itself might match.
          if (matchesSafe(node, selector)) {
            if (!seen.has(node) && !(guard && !guard())) {
              seen.add(node);
              try {
                fn(node);
              } catch {
                // ignore
              }
            }
          }
          // Or any descendant.
          tryApply(node);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const stopper = setTimeout(() => observer.disconnect(), timeoutMs);

  return () => {
    observer.disconnect();
    clearTimeout(stopper);
  };
}

export function safeQuerySelectorAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}
