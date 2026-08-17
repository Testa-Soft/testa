# @testa-soft/dom

The browser **render layer** for Testa experiments. Given a variation's changes,
it applies them to the DOM and shields the page against flicker while it does.
It pairs with [`@testa-soft/experiment-core`](https://www.npmjs.com/package/@testa-soft/experiment-core)
(the decision layer): core decides *which* variation a visitor gets; this package
*renders* it.

> **You usually don't install this directly.** It's the shared DOM engine behind
> the framework integrations — [`@testa-soft/next`](https://www.npmjs.com/package/@testa-soft/next)
> and the client SDK. Install one of those; this comes along as a dependency. It's
> published so every surface applies variations identically.

## What's inside

- **`applyVariation(variationId, changes)`** — apply a variation's crobot-native DOM changes, returning teardowns for the DOM-watching appliers. Change types: `change_html`, `css`, `hide_element`, `append_html`, `prepend_html`, `move_element_append`, `move_element_prepend`.
- **Late-render safe** — a `MutationObserver` re-targets elements that render after apply (SPA / async content), with a timeout fallback. `append`/`prepend` remove their inserted nodes on teardown, so re-applying never stacks duplicates.
- **Anti-flicker shield** — `raiseShield()` / `buildShieldSnippet()`: hide the page (or a selector) until the variant is applied, with a hard timeout fallback so a slow or broken apply can never leave the page blank. `buildShieldSnippet()` emits an inlinable `<head>` IIFE for SSR frameworks.

## Install

```bash
npm install @testa-soft/dom
```

Ships ESM + CJS + types. Browser-only (uses `document` / `MutationObserver`).

## License

UNLICENSED — © testa-soft.
