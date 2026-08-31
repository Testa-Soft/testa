# Testa for React + Vite SPAs — integration guide

`@testa-soft/react` runs the full Testa experiment engine **in the browser** —
for single-page apps that have no server to redirect from (Vite, CRA, static
hosting, S3/CDN deploys). It shares the exact decision core
(`@testa-soft/experiment-core`) and render layer (`@testa-soft/dom`) with the
Next.js package, so a visitor buckets into the same variation on every surface.

> Have a Next.js app? Use [`@testa-soft/next`](./nextjs.md) instead — its
> server-side 307 redirects are flicker-free by construction. This package is
> for apps where everything must happen client-side.

## Installation

```bash
npm install @testa-soft/react
```

Peer dependency: `react >= 18`.

## Concepts

**Everything is client-side.** Assignment, split-URL redirects, DOM changes,
exposure and goal tracking all run in the browser. The trade-off vs the Next.js
package: redirects are a fast client navigation instead of an edge 307, so the
provider ships a built-in anti-flicker shield to keep the control page hidden.

**Assignment is deterministic and sticky.** Visitors bucket via
`xxhash32(visitorId:experimentId) mod 100` and stick via the `_testa_exp`
cookie — no re-rolling, ever, and no SRM from `Math.random()`.

**Three ways to run an experiment**, all reading the same assignment:
code-based branching (`useTestaVariant`), editor-authored DOM changes (applied
automatically), and split-URL redirects.

## Quick start

Wrap your app once. With just `projectId`, config is fetched from the built-in
config host:

```tsx
// main.tsx
import { createRoot } from 'react-dom/client'
import { TestaProvider } from '@testa-soft/react'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <TestaProvider projectId="3fa85f64e1c2b">
    <App />
  </TestaProvider>,
)
```

That is the whole integration. The config fetch starts during the provider's
first render (before paint, deduped across StrictMode double-mounts); on mount
and on every SPA navigation the provider assigns the visitor, performs any
split-URL redirect, applies DOM changes, and arms goal tracking. A failed
config fetch **fails open** — your app renders untouched.

Prefer shipping config with your build (zero-latency, static/edge deploys)?
Pass `config={projectConfig}` instead of `projectId`.

## `useTestaVariant` — code-based experiments (recommended)

DOM-mutation experiments fight React: a re-render can wipe an applied change.
For anything **your app renders**, branch in JSX instead — React owns the
output, so this is the most robust path in a SPA:

```tsx
import { useTestaVariant } from '@testa-soft/react'

function PricingCta() {
  const { variationId, isControl } = useTestaVariant(101)

  if (isControl || variationId === null) return <button>Start free trial</button>
  return <button>Get started — 50% off today</button>
}
```

`variationId` is `null` when the visitor isn't assigned (not enrolled,
excluded, or off the experiment's page); `isControl` is `true` for the
experiment's control variation. Always render the control for `null`.

## HTML/DOM experiments (no code changes)

Editor-authored, crobot-native DOM changes (`change_html`, `css`,
`hide_element`, `append_html`, `prepend_html`, `move_element_*`) apply
automatically, cookie-first. Nothing to wire up beyond the provider.

Because these mutate already-painted content, the provider raises a **smart
anti-flicker overlay** on initial load (`shield` prop, default on):

- Raised pre-paint while config loads; revealed the moment the variant is
  applied (or instantly when nothing applies). A 4s hard timeout guarantees a
  broken apply never leaves the page blank.
- **Smart skip:** after the first load the provider persists a
  `localStorage['__testa_shield_hint']` recording whether the project has
  anything to apply — projects with no active DOM changes stop shielding
  entirely on later visits.
- Stays up while a split-URL redirect navigates away; never re-shields on soft
  navigations.

`shield={false}` disables it; `shield={{ selector, timeoutMs, mode, styleId }}`
customizes it. For coverage before your JS bundle even loads, inline
`buildShieldSnippet()` from `@testa-soft/dom` in `index.html`'s `<head>` — the
provider detects it (same style id) and won't double-shield.

## Split-URL redirects

With no server, the provider redirects client-side via
`window.location.replace(destination)` as early as possible on load,
loop-guarded by a per-experiment `_testa_redirected_<id>` cookie. The shield
keeps the source page hidden while the navigation happens.

## Goals & conversions

Armed automatically per navigation for every experiment the visitor is assigned
to (control included, not page-gated — goals usually complete on a different
page). `page_view` and `click` goals need nothing; `custom` goals fire via:

```ts
import { pushEvent } from '@testa-soft/react'
pushEvent('signup_done', { plan: 'pro' })
```

`window.testa.pushEvent` / `window.Analytica.pushEvent` are also installed for
GTM Custom HTML and non-bundled scripts. Conversions POST the legacy crobot
payload, so results populate identically to the pixel; crobot dedups
once-per-visitor server-side.

## Analytics events (GA4 / GTM / PostHog / Segment)

Same client event bus as `@testa-soft/next`. Two events, two moments:

- **`variation_applied`** — the visitor was **shown** the variation: on the page
  for DOM/copy tests, after the navigation for split-URL. Once per page load per
  `(experiment, variation)`.
- **`variation_assigned`** — the visitor was **bucketed**, at decision time and
  *before* any split-URL redirect leaves the page — the only event a redirected
  visitor can be counted by.

**Multiple handlers are allowed**, and each registration returns an unsubscribe:

```ts
import { testa } from '@testa-soft/react'

const off = testa.onVariationApplied((d) => posthog.capture('$experiment_viewed', d))
testa.onVariationApplied((d) => analytics.track('Experiment Viewed', d))
testa.onVariationAssigned((d) => logEnrollment(d))
off() // removes just that one handler

// d = {
//   project_id: 123,
//   experiment: 456,                     // experiment identifier, not the DB pk
//   variation: 1,                        // 0 = control
//   uuid: "0198f2c1-4b7a-7f3e-9d21-...",
//   title: "Homepage Hero Test",         // omitted when the experiment has no name
//   url: "https://example.com/pricing",
// }
```

`experiment` and `variation` are crobot IDENTIFIERS (0-based; variation `0` is
always the control), not database primary keys.

Three guarantees worth relying on:

- **History replay** — a handler registered *after* the event fired still
  receives it, so late-loading analytics never miss an exposure.
- **Per-handler dedup** — each handler sees each unique `(experiment, variation)`
  event at most once, so a re-render or soft-nav re-apply can't double-count.
- **Handler isolation** — a throwing handler breaks neither the SDK nor the other
  handlers.

`window.testa.onVariationApplied` is installed too, for GTM Custom HTML and
non-bundled scripts. Every `variation_applied` also pushes the GTM `dataLayer`
event `Analytica` (`ExperimentId`, `ExperimentName`, `VariationId`,
`VariationName`) — add a GTM Custom Event trigger on `Analytica`. `VariationName`
is `Control` for variation `0`, else the configured name or `Variation<id>`.

## Preview mode

Editors preview unpublished drafts live. Pass
`previewApiUrl="https://new.testa-soft.tech"` (your crobot backend), then open
any page with `?testa_preview=true&testa_preview_token=<token>`. The provider
skips normal assignment, fetches the session's draft changes from
`{previewApiUrl}/api/preview/{token}`, and applies them. Failures apply nothing
(fail-safe).

## SPA navigation

The provider patches `history.pushState`/`replaceState` and listens to
`popstate`, so the engine re-runs on every soft navigation — React Router,
TanStack Router, Wouter, or hand-rolled history all work. The previous route's
DOM changes are disposed before the next route's apply.

## API reference

### `<TestaProvider>` props

| Prop            | Type                       | Default                          | Description                                                        |
| --------------- | -------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `projectId`     | `string`                   | —                                | Project id. Config fetched from `{host}/api/v1/config/{projectId}`. |
| `config`        | `ProjectConfig`            | —                                | Inline config. Zero-latency, no fetch. Wins over `projectId`.       |
| `host`          | `string`                   | `https://config.testa-soft.tech` | Config host. Override for local/staging.                            |
| `previewApiUrl` | `string`                   | —                                | Backend base URL for preview mode (`?testa_preview`).               |
| `tracking`      | `boolean`                  | `true`                           | Emit exposures on fresh enrollment so results populate.             |
| `trackingHost`  | `string`                   | `https://new.testa-soft.tech`    | Host for exposure + conversion tracking (`/api/leads`).             |
| `secureCookies` | `boolean`                  | `true`                           | Emit `Secure` cookies. `false` for local http dev.                  |
| `cookieDomain`  | `string`                   | —                                | Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`).     |
| `shield`        | `boolean \| ShieldOptions` | `true`                           | Smart anti-flicker overlay. `false` to disable; object to customize. |

### Event bus

| Export | Type | Description |
| --- | --- | --- |
| `testa.onVariationApplied` | `(handler) => Unsubscribe` | Subscribe to `variation_applied`. Multiple handlers; history replay; per-handler dedup. |
| `testa.onVariationAssigned` | `(handler) => Unsubscribe` | Subscribe to `variation_assigned` (bucketing). Same semantics. |
| `onVariationApplied` | `(handler) => Unsubscribe` | Standalone equivalent of `testa.onVariationApplied`. |
| `onVariationAssigned` | `(handler) => Unsubscribe` | Standalone equivalent of `testa.onVariationAssigned`. |
| `window.testa` | `{ onVariationApplied, onVariationAssigned }` | Same API for GTM Custom HTML / non-bundled scripts. |
| `installTestaGlobal` | `() => void` | Attach `window.testa` by hand. Idempotent; the provider already calls it. |
| `pushEvent` | `(name, data?) => void` | Fire a custom goal (also `window.testa.pushEvent`). |

Handler signature: `(event: VariationEvent) => void`, where `VariationEvent` is
`{ project_id, experiment, variation, uuid, title?, url }`.

### Other exports

`useTestaVariant(experimentId)`, `TestaShield` / `raiseShield` for manual shield
control, and the lower-level building blocks (`initTesta`, `runExperiments`,
`ConfigClient`, `DocumentCookieStore`, `emitExposure`, preview helpers,
`installSpaNav`) for custom integrations.

## Troubleshooting

**Nothing happens at all.** The provider fails open on config failure — confirm
`projectId` (or `config`) is correct and the config host is reachable from the
browser (check the network tab for `/api/v1/config/…`).

**A DOM change disappears after a re-render.** React reconciled over it. Move
that experiment to `useTestaVariant` — code-based branching is immune.

**Split-URL loops or doesn't fire.** The redirect only enrolls on the
experiment's page rule and is loop-guarded by `_testa_redirected_<id>`. Check
the page rule and match type, and that the destination URL isn't itself matched
by the rule.

**Blank flash on every load.** The smart shield should skip itself for projects
with nothing to apply (after the first visit). If you see persistent shielding,
check that `localStorage` is writable; `shield={false}` disables it outright.

**No `variation_applied` event.** It fires once per session on the applied
page. Handlers registered later still get it via history replay.
