/**
 * Every node an experiment put into the page, held weakly so it is collected
 * with the document.
 *
 * The link router reads it to tell "a link the variation authored" from "a
 * link the host app rendered": only the first kind is ours to route. The app's
 * own links already go through its router (`<Link>`), and intercepting them
 * would mean second-guessing code we don't own.
 *
 * A WeakSet rather than a marker attribute, for the same reason as the
 * `change_html` keeper: nothing we do should be visible in the customer's DOM.
 */

const injectedNodes = new WeakSet<Node>();

/** Record a node an applier inserted. Text nodes are fine — they just never match. */
export function markInjected(node: Node): void {
  injectedNodes.add(node);
}

/** Whether `el` is, or sits inside, a node an applier inserted. */
export function isInsideInjected(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (injectedNodes.has(node)) return true;
  }
  return false;
}
