# @testa-soft/react demo (Vite + React SPA)

A runnable, no-server SPA (Lovable-style) using `@testa-soft/react`.

```bash
pnpm --filter @testa-demo/react-spa dev   # http://localhost:3200
```

## What it shows

- **`<TestaProvider>`** at the root (`src/main.tsx`) — runs the whole client cycle:
  client-side assignment (sticky `_testa_exp` cookie), DOM apply, exposure
  tracking, preview, and re-apply on SPA navigation.
- **The robust React paths**, both surviving react-router navigation:
  - **`css` experiment (202)** — colours `#hero`. CSS lives in `<head>`, which
    React never reconciles, so it's rock-solid.
  - **code-based experiment (303)** via **`useTestaVariant`** — the CTA renders
    its variant through React, so it can't be clobbered.
- **The anti-flicker shield** — inlined in `index.html`'s `<head>` (a React
  `<script>` runs after first paint); `<TestaProvider>` reveals it once the
  variant is committed. Hard-reload and you won't see the control flash.

## Note on content-mutation vs code

`change_html`/`append_html` on an element React re-renders will fight
reconciliation (React restores its own markup on the next render). For content
changes in a React SPA, prefer **`useTestaVariant`** (as the CTA here does) — the
app owns the variant, so it's stable. `css` and structural changes on
non-React-managed nodes are fine via the DOM engine.
