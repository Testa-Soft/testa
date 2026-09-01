# @testa-soft/react

Client-side [Testa](https://testa-soft.tech) A/B testing for **React + Vite SPAs** — any single-page app that has **no server**. One `<TestaProvider>` at your app root runs the whole experiment engine in the browser: deterministic, sticky assignment; client-side split-URL redirects; cookie-first HTML/DOM changes; exposure tracking; preview mode; and automatic re-runs on SPA route changes. For experiments your app renders itself, `useTestaVariant` gives you a robust, code-based branch that survives React reconciliation.

It shares the exact decision core (`@testa-soft/experiment-core`) and render layer (`@testa-soft/dom`) as the Next.js package, so a visitor buckets into the same variation no matter which surface they hit.

## Install

```bash
npm install @testa-soft/react
```

Peer dependency (you already have it):

- `react` — `>=18`

## Quick start

Wrap your app once. With just `projectId`, the package fetches your project config from the built-in config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`):

```tsx
// main.tsx
import { createRoot } from 'react-dom/client'
import { TestaProvider } from '@testa-soft/react'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <TestaProvider projectId="acme">
    <App />
  </TestaProvider>,
)
```

That is the whole integration. The config fetch starts during the provider's **first render** (before paint, deduped across StrictMode double-mounts), and on mount (plus every SPA navigation) the provider assigns the visitor, performs any split-URL redirect, and applies HTML/DOM changes — behind a built-in **smart anti-flicker overlay** (see below).

### Inline-config mode

If you'd rather ship the config with your build (zero-latency, no network — handy for static or edge deploys), pass a `config` object instead of `projectId`:

```tsx
import { TestaProvider } from '@testa-soft/react'
import projectConfig from './testa.config.json'

<TestaProvider config={projectConfig}>
  <App />
</TestaProvider>
```

You can also point at a custom host with `host="https://config.staging.example.com"`. A failed config fetch fails open — no experiments run and your app renders untouched.

## `useTestaVariant` — robust code-based experiments (recommended)

DOM-mutation experiments fight React: a re-render can wipe an applied change. For anything **your app renders**, read the assigned variation and branch in JSX instead. This is the most reliable path in a React SPA because React owns the output:

```tsx
import { useTestaVariant } from '@testa-soft/react'

function PricingCta() {
  const { variationId, isControl } = useTestaVariant(101)

  if (isControl || variationId === null) {
    return <button>Start free trial</button>
  }
  return <button>Get started — 50% off today</button>
}
```

`useTestaVariant(experimentId)` returns `{ variationId, isControl }`, read cookie-first from the sticky `_testa_exp` assignment surfaced by `<TestaProvider>`. `variationId` is `null` when the visitor isn't assigned (not enrolled, excluded, or off the experiment's page). `isControl` is `true` when the assigned variation is the experiment's control (its lowest variation id).

## HTML/DOM experiments (no code changes)

For "same URL, different content" tests authored in the Testa editor, the provider applies **crobot-native DOM changes** on the client, cookie-first — no re-bucketing. Nothing extra to wire up beyond `<TestaProvider>`.

Because these mutate content the browser already painted, there can be a brief control→variant flash. The provider handles this **automatically** with a smart anti-flicker overlay (`shield` prop, default on):

- **Initial load:** the overlay is raised before first paint (a pre-paint layout effect) while the config loads, and revealed the moment the assigned variant is applied — or immediately when nothing applies. A 4s hard timeout guarantees a slow or broken apply never leaves the page blank (fail open).
- **Smart skip:** after the first config load the provider persists a hint (`localStorage['__testa_shield_hint']`) recording whether the project has any active experiments with changes. Projects with nothing to apply **stop shielding entirely** on subsequent visits — no needless blank frame.
- **Redirects:** the overlay stays up while a client-side split-URL redirect navigates away, so the control page never flashes.
- **Soft navigations:** never re-shielded — re-apply is near-instant.

Pass `shield={false}` to manage flicker yourself, or `shield={{ selector, timeoutMs, mode, styleId }}` to customize. For the absolute earliest coverage (before your JS bundle even loads — e.g. slow networks), you can still inline `buildShieldSnippet()` from `@testa-soft/dom` in `index.html`'s `<head>`; the provider detects it (same style id) and won't double-shield.

Supported change types are crobot-native and applied by the shared DOM engine: `change_html`, `css`, `hide_element`, `append_html`, `prepend_html`, `move_element_append`, `move_element_prepend`.

## Split-URL redirects happen client-side

Split-URL tests send a bucketed visitor to a different URL. With no server to issue a `307`, the provider performs the redirect **client-side** via `window.location.replace(destination)` as early as it can on load. It's loop-guarded by a per-experiment `_testa_redirected_<id>` cookie so a visitor is never bounced back and forth. Because there's no edge, expect a brief navigation rather than the flicker-free server redirect the Next.js package gives you — the provider's built-in shield keeps the source page hidden while the redirect navigates away.

## Analytics events

The SDK emits two client-side events. Subscribe with named functions — **multiple handlers are allowed**, and each call returns an unsubscribe function:

- **`variation_applied`** — the visitor was **shown** a variation: on the page for DOM/copy tests, after the navigation for split-URL. Fires **once per page load** per `(experiment, variation)`.
- **`variation_assigned`** — the visitor was **bucketed**, fired at decision time, *before* any split-URL redirect leaves the page. This is the only event a redirected visitor can be counted by, since they never reach the apply step.

Subscribe from a component, in an effect. `onVariationApplied` returns its own
unsubscribe, so returning it from the effect is the whole cleanup — without it,
Fast Refresh and StrictMode's double mount stack duplicate handlers.

```tsx
import { onVariationApplied } from '@testa-soft/react'
import { useEffect } from 'react'

export function TestaAnalytics(): null {
  // `track` is whatever you already use — an analytics SDK, or your own fetch.
  useEffect(() => onVariationApplied((d) => track('Experiment Viewed', d)), [])
  return null
}
```

Render it once inside `<TestaProvider>`. Module-scope
`testa.onVariationApplied(...)` also works and is the right shape outside a React
tree, but nothing unsubscribes it.

The payload (crobot 3.3.3 `leadData`), identical for both events:

```ts
{
  project_id: 123,                     // crobot project id
  experiment: 456,                     // experiment IDENTIFIER (0-based), not the DB pk
  variation: 1,                        // variation IDENTIFIER (0 = control)
  uuid: "0198f2c1-4b7a-7f3e-9d21-...", // visitor id
  title: "Homepage Hero Test",         // experiment title — omitted when unset
  url: "https://example.com/pricing",  // the URL the variation was applied on
}
```

**History replay.** A handler registered **after** the event already fired still receives it — late-loading analytics never miss an exposure. Each handler also sees each unique `(experiment, variation)` event at most once, so a re-render or a soft-nav re-apply won't double-count.

**A throwing handler can't break the SDK** (or the other handlers) — the bus isolates each delivery.

**GTM Custom HTML / non-bundled scripts.** The same API is installed on `window.testa`, so you can subscribe without importing the package:

```html
<script>
  window.testa.onVariationApplied(function (d) {
    // push to your own analytics
  })
</script>
```

**GTM `dataLayer`** — pushed automatically on every `variation_applied`, no configuration:

```js
{ event: 'Analytica', ExperimentId, ExperimentName, VariationId, VariationName }
```

Add a GTM **Custom Event** trigger on `Analytica`. `VariationName` is `Control` for variation `0`, otherwise the configured name or `Variation<id>`.

## Preview mode

Editors can preview **unpublished** variation drafts live. Pass `previewApiUrl` (your Testa/crobot backend base URL):

```tsx
<TestaProvider projectId="acme" previewApiUrl="https://new.testa-soft.tech">
  <App />
</TestaProvider>
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode the provider **skips normal assignment** and instead fetches the draft changes for that session from `{previewApiUrl}/api/preview/{token}` and applies them, so a draft renders exactly as it will ship. A failed or malformed response applies nothing (fail-safe).

## SPA navigation

The provider installs a framework-agnostic navigation detector — it patches `history.pushState`/`replaceState` and listens to `popstate` — so the engine re-runs on every soft navigation. It works with React Router, TanStack Router, Wouter, or hand-rolled `history` navigation, disposing the previous route's DOM changes before applying the next.

## `<TestaProvider>` props

| Prop            | Type            | Default                          | Description                                                                    |
| --------------- | --------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `projectId`     | `string`        | —                                | Project id. Config is fetched from `{host}/api/v1/config/{projectId}`.         |
| `config`        | `ProjectConfig` | —                                | Inline config. Zero-latency, no fetch. Wins over `projectId`.                  |
| `host`          | `string`        | `https://config.testa-soft.tech` | Config host. Override for local/staging.                                       |
| `previewApiUrl` | `string`        | —                                | Backend base URL for preview mode (`?testa_preview`).                          |
| `tracking`      | `boolean`       | `true`                           | Emit exposures on fresh enrollment so results populate.                        |
| `trackingHost`  | `string`        | `https://new.testa-soft.tech`    | Host for exposure tracking (`/api/leads`).                                     |
| `secureCookies` | `boolean`       | `true`                           | Emit `Secure` cookies. Set `false` for local http dev.                         |
| `cookieDomain`  | `string`        | —                                | Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`).                |
| `shield`        | `boolean \| ShieldOptions` | `true`                | Smart anti-flicker overlay on initial load. `false` to disable; options object to customize selector/timeout/mode. |

## How it works

- **Deterministic, sticky assignment.** The provider buckets each visitor with `xxhash32(visitorId:experimentId) mod 100` and writes the sticky `_testa_exp` cookie. A returning visitor is never re-rolled, and `useTestaVariant`, DOM apply, and redirects all read that one cookie.
- **Client-side redirects, loop-guarded.** Split-URL tests `location.replace` to the variant, guarded by `_testa_redirected_<id>` so there's no bounce loop.
- **DOM changes behind a smart shield.** HTML/DOM variants apply cookie-first after mount and re-apply on soft navigation; the provider's built-in overlay prevents the control→variant flash and skips itself when the project has nothing to apply.
- **Exposures feed results.** One exposure per fresh enrollment is POSTed to the tracking host (deduped server-side).
