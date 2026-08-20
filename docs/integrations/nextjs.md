# Testa for Next.js (`@testa-soft/next`)

Run Testa A/B experiments in a Next.js app with **one proxy and (optionally) two
components**. You get two kinds of experiments from a single integration:

- **Split-URL redirects** — send a bucketed visitor to a different URL. Decided
  server-side in the proxy and issued as a `307` **before any HTML is sent**, so
  there is zero flicker and no client JavaScript is required.
- **HTML/DOM experiments** — "same URL, different content" changes (edit text,
  styles, show/hide/insert/move elements). Assigned server-side, applied on the
  client, with a built-in anti-flicker shield.

Both read the same sticky `_testa_exp` cookie, so a visitor is **bucketed once —
server-side — and stays in the same variation** across page loads, soft
navigations, and experiment types.

---

## Installation

```bash
npm install @testa-soft/next
```

Peer dependencies (a Next.js app already has these):

- `next` — `>=13.4.0`
- `react` — `>=18` (only needed if you use the client components)

---

## Concepts

**Server assigns, everything else follows.** The proxy runs on every matched
request, buckets the visitor deterministically (a stable hash of their id — never
`Math.random()`, so no sample-ratio mismatch), and writes the sticky `_testa_exp`
cookie. From then on every surface — the proxy, the client components — just
*reads* that cookie. Nobody re-rolls the dice.

**Split-URL is flicker-free by construction.** The redirect happens at the edge
before markup is streamed, so the control page is never painted.

**HTML changes happen on the client, behind a shield.** DOM changes have to mutate
content the server already rendered, so there's an unavoidable control→variant
moment. The shield hides the page until the variant is applied.

---

## Split-URL experiments

Create `proxy.ts` at your project root (or under `src/`):

```ts
// proxy.ts
import { createTestaProxy } from '@testa-soft/next'

export const proxy = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export const config = {
  // Run on real pages; skip Next internals, static assets, and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

> **Next.js version.** Next 16 renamed the middleware file convention to
> `proxy` — use `proxy.ts` with `export const proxy = …` (above). On **Next
> 13–15**, name the file `middleware.ts` and the export `middleware` instead;
> everything else is identical. `createTestaProxy` is unchanged either way, and
> the `config.matcher` is the same on both.

That is the entire integration for split-URL. `projectId` is your **crobot
project UUID**. With just `projectId`, the package fetches your project config
from the Testa config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`)
and caches it. A bucketed visitor is redirected server-side; everyone else passes
through untouched. If no config can be resolved, the proxy **fails open** and does
nothing.

### Where the config comes from

| Option        | Use it when                                                              |
| ------------- | ----------------------------------------------------------------------- |
| `projectId`   | Default. Fetches from the built-in config host.                         |
| `host`        | Point at a staging/self-hosted config host.                             |
| `configUrl`   | Fetch a `ProjectConfig` JSON from a URL you control.                    |
| `loadConfig`  | Provide an async resolver (e.g. read Vercel Edge Config).               |
| `config`      | Pass a static `ProjectConfig` object — zero latency, no network fetch.  |

Inline example (handy for local dev, demos, or self-managed config):

```ts
// proxy.ts  (Next 13–15: middleware.ts, export `middleware`)
import { createTestaProxy } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  config: projectConfig, // a ProjectConfig — zero-latency, no network fetch
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

Config caching (`cache` option), shared per server instance:

- `true` (default) — fresh for 60s, then served stale while revalidating in the
  background (never older than 5 min): zero request latency, publishes live in
  ~1 min. `cacheTtlMs` tunes the fresh window.
- `'per-pageload'` — DOCUMENT requests always fetch fresh (a publish is live on
  the very next hard pageview); RSC soft navigations reuse the pinned copy, so
  the config never shifts mid-SPA-session.
- `false` — no server-side cache; every request fetches (testing only).

---

## HTML/DOM experiments

Add two **zero-config server components** to your root layout (App Router):
`<TestaGuard/>` as high in `<head>` as possible, and `<TestaProvider/>` in
the body. Keep the proxy too — DOM experiments reuse its server-side assignment.

```tsx
// app/layout.tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/server'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Anti-flicker. Self-gating: renders ONLY when the proxy flagged a
            pending DOM change for this request — split-URL-only pages and
            visitors with nothing to apply never get shielded. */}
        <TestaGuard selector="body" timeoutMs={4000} />
      </head>
      <body>
        {children}
        {/* Fetches the same ProjectConfig the proxy resolves — server-side, on
            the first request, cached in the Next data cache (60s background
            revalidation). No app-side fetch code. Then reads _testa_exp and
            applies the assigned variation's DOM changes client-side,
            re-applying on App-Router soft navigation. Fails open (renders
            nothing) if the config host is unreachable. */}
        <TestaProvider projectId="3fa85f64e1c2b" />
      </body>
    </html>
  )
}
```

`projectId` is the same id you pass to `createTestaProxy`. That's the whole
integration — no config fetching, no `headers()` plumbing.

### Inline config (client entry)

If you manage the config yourself (local dev, demos, self-managed JSON), the
underlying **client** components from `@testa-soft/next/experiments` take an
explicit `config` prop instead — or pass `config` straight to the `/server`
components to skip their fetch:

```tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/experiments'
import projectConfig from './testa.config.json'
// <TestaGuard selector="body"/> in <head> (always renders — not self-gating),
// <TestaProvider config={projectConfig}/> in the body.
```

Supported change types:

| Change type            | Effect                                                        |
| ---------------------- | ------------------------------------------------------------ |
| `change_html`          | Set matched elements' `innerHTML`.                           |
| `css`                  | Inject a stylesheet.                                         |
| `hide_element`         | `display:none` on matched elements.                          |
| `append_html`          | Insert HTML at the end of matched elements.                  |
| `prepend_html`         | Insert HTML at the start of matched elements.                |
| `move_element_append`  | Move matched elements under a target selector (append).      |
| `move_element_prepend` | Move matched elements under a target selector (prepend).     |

> Split-URL-only deployments don't need `<TestaGuard/>` — the `307` is already
> flicker-free. The shield only matters when applying DOM changes on top of
> server-rendered content.

### Preview mode (for editors)

Preview **unpublished** variation drafts without exposing them to real visitors.
Pass `previewApiUrl` (your Testa backend base URL) to `<TestaProvider/>`
(works on both the `/server` and `/experiments` variants):

```tsx
<TestaProvider projectId="3fa85f64e1c2b" previewApiUrl="https://new.testa-soft.tech" />
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode the component **skips normal assignment** and instead fetches the
draft changes for that session and applies them, so a draft renders exactly as it
will ship. A failed or malformed response applies nothing (fail-safe).

---

## Pages Router soft navigation

Client-side navigations in the **Pages Router** (static `next/link` navs) never
reach the server, so the proxy can't see them. `<TestaRouterGuard/>` is an
optional catch-all — add it once in your Pages-Router layout (`_app`):

```tsx
// pages/_app.tsx
import { TestaRouterGuard } from '@testa-soft/next/router-guard'
import projectConfig from '../testa.config.json'

export default function App({ Component, pageProps }) {
  return (
    <>
      <TestaRouterGuard config={projectConfig} />
      <Component {...pageProps} />
    </>
  )
}
```

It reads the same sticky `_testa_exp` cookie and, on a navigation to a control URL
for a split-URL experiment the visitor is bucketed to a variant of, redirects to
the variant before the control page renders.

> **App Router users don't need this.** `<TestaProvider/>` re-applies DOM
> experiments on soft navigation, and the proxy handles split-URL redirects
> (including a prefetch-safe path for `<Link>` prefetches).

---

## Goals & conversions

Goals are created in crobot and attached to an experiment; the SDK arms them
client-side (via `<TestaProvider/>`) on every navigation, for every
experiment the visitor is **assigned** to and whose session is live. Goals are
deliberately **not page-gated** — a goal usually completes on a different page
than the experiment runs on. Conversions POST the legacy
`{trackingHost}/api/leads/convert` payload (`goal_id`, `action`, `lead_uuid`,
`variation`, `data`) — identical to the 3.3.3 pixel — so results populate the
same either way. crobot counts each goal **once per visitor**; the client also
guards once per page load.

| Goal type   | Fires when                                                                | Code needed |
| ----------- | ------------------------------------------------------------------------- | ----------- |
| `page_view` | The current URL matches the goal pattern (`exact`/`contains`/`regex`).    | none        |
| `click`     | The **first** element matching the goal's CSS selector is clicked (650ms setup delay + late-render retries, 3.3.3 parity). Prefer specific selectors (`#cta`, `[data-goal=…]`). | none |
| `custom`    | Your code emits a matching event name.                                     | one call    |

Custom events, from bundled code:

```ts
import { pushEvent } from '@testa-soft/next'

pushEvent('signup_completed', { plan: 'pro' })
```

From non-bundled scripts / GTM Custom HTML, the same call is installed as
`window.testa.pushEvent(...)` **and** — for 3.3.3 docs parity —
`window.Analytica.pushEvent(...)` (non-clobbering: a real legacy pixel's own
`pushEvent` is never overwritten, so dual-running sites keep pixel behavior).
Note the globals exist from hydration onward; calls made before hydration are
dropped (same failure mode as the legacy pixel pre-load — fire conversion
events on user actions, or import `pushEvent` from the package).

---

## Analytics events (GA4 / GTM / PostHog / Segment)

Testa exposes experiment exposures on **two independent surfaces** — a
**client-side** event bus in the browser, and a **server-side** hook in the proxy.
Use either, or both; they don't depend on each other.

Two events, two moments:

- **`variation_assigned`** — the visitor is **bucketed** (server-side, in the
  proxy). This is the assignment decision.
- **`variation_applied`** — the visitor is **shown** the variation (client-side,
  **once per session**): after the redirect for split-URL, on the page for DOM.

### Client-side (`variation_applied`)

The SDK fires `variation_applied` in the browser once per session when a visitor
is shown a variation. Subscribe with named functions — **multiple handlers are
allowed**, and each call returns an unsubscribe function:

```ts
import { testa } from '@testa-soft/next'

// PostHog (client)
const off = testa.onVariationApplied((d) => {
  posthog.capture('$experiment_viewed', {
    experiment: d.experiment,
    variation: d.variation,
    title: d.title,
  })
})

// Segment
testa.onVariationApplied((d) => {
  analytics.track('Experiment Viewed', d)
})

// Raw handler — do anything you like with the payload
testa.onVariationApplied((d) => {
  console.debug('shown variation', d.experiment, d.variation, 'at', d.url)
})

// off() removes just that one handler
```

The payload is:

```ts
d = {
  project_id, // crobot project id (number)
  experiment, // experiment IDENTIFIER (0-based), not the DB pk
  variation,  // variation IDENTIFIER (0 = control)
  uuid,       // visitor id
  title,      // experiment title, when set
  url,        // the URL the variation was applied on
}
```

**History replay.** A handler registered **after** the event already fired still
receives it. Analytics scripts often load late — they won't miss the exposure.
Each handler also sees each unique `(experiment, variation)` event at most once.

**GTM Custom HTML / non-bundled scripts.** The same API is installed on
`window.testa`, so you can subscribe without importing the package:

```html
<script>
  window.testa.onVariationApplied(function (d) {
    // e.g. push to your own analytics
  })
</script>
```

### GTM `dataLayer`

On **every** `variation_applied`, the SDK also pushes to the GTM `dataLayer`
automatically — this is **not configurable**:

```js
{
  event: 'Analytica',
  ExperimentId,   // = experiment identifier
  ExperimentName, // = experiment title (empty string if unset)
  VariationId,    // = variation identifier
  VariationName,  // 'Control' for id 0, else 'Variation<id>'
}
```

In GTM, add a **Custom Event** trigger that fires on the event name `Analytica`,
then wire it to whatever tag you want (GA4 event, a pixel, etc.). The
`{{ExperimentId}}` / `{{VariationId}}` data-layer variables are available on that
trigger.

### Server-side (`variation_assigned`)

For server-side destinations — PostHog server, a data warehouse, a webhook — use
the `onVariationAssigned` option on `createTestaProxy`. It fires for each
variation the visitor is assigned on a request:

```ts
// proxy.ts
import { createTestaProxy } from '@testa-soft/next'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  onVariationAssigned: (event, ctx) => {
    // Fire once per visitor, not once per request.
    if (!event.firstAssignment) return

    // ctx.waitUntil keeps this fetch alive AFTER the response is sent,
    // without delaying it — edge/runtime-safe.
    ctx.waitUntil(
      fetch('https://us.i.posthog.com/capture/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.POSTHOG_API_KEY,
          event: '$experiment_assigned',
          distinct_id: event.visitorId,
          properties: {
            experiment_id: event.experimentId,
            variation_id: event.variationId,
            title: event.title,
            url: event.url,
          },
        }),
      }),
    )
  },
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

The hook signature is `(event, ctx) => void | Promise<void>`. Errors and
rejections are swallowed so a hook can never break the request.

- **`ctx.waitUntil(promise)`** — keeps an async call alive until it completes
  **after** the response has been sent. It never delays the response, so tracking
  latency is invisible to the visitor. Use it for any network call (PostHog
  server, warehouse, webhook).
- **`event.firstAssignment`** — `true` only when the visitor was freshly bucketed
  on this request (`false` when served from the sticky cookie). Guard on it for
  **once-per-visitor** semantics.

The server-side `event` (type `VariationAppliedEvent`) uses different field names
from the client payload — document them per surface:

| Field              | Type      | Meaning                                              |
| ------------------ | --------- | ---------------------------------------------------- |
| `experimentId`     | `number`  | Experiment identifier.                               |
| `variationId`      | `number`  | Variation identifier (0 = control).                  |
| `visitorId`        | `string`  | Visitor id (client payload calls this `uuid`).       |
| `title`            | `string?` | Experiment title, when set.                          |
| `url`              | `string`  | The request URL the variation was applied on.        |
| `firstAssignment`  | `boolean` | `true` on a fresh bucketing, `false` from the cookie.|
| `redirected`       | `boolean` | `true` when the assignment triggered a `307`.        |
| `destinationUrl`   | `string?` | The redirect destination, present when `redirected`. |

> **Field names differ by surface.** The **client** payload uses
> `experiment` / `variation` / `uuid`; the **server** event uses
> `experimentId` / `variationId` / `visitorId`. Same concepts, different keys —
> reach for the right ones on each side.

### Which surface should I use?

The two surfaces are **independent**. Client-side (`variation_applied`) is right
for anything that lives in the browser session — GA4, GTM, PostHog client,
Segment. Server-side (`onVariationAssigned`) is right for destinations you'd
rather not trust to the client — a warehouse, a server-side PostHog, a webhook —
and it fires even if the visitor has JavaScript disabled. Wire up whichever you
need; wire up both if you want the exposure in two places.

---

## Targeting (audience rules)

Targeting is **session-scoped and first-touch**, matching crobot 3.3.3. When a
visitor first touches your site, Testa evaluates the experiment's targeting
**site-wide** and **caches the verdict** (eligible or excluded) on the sticky
cookie. That cached verdict is then honored for the rest of the session — so a
UTM (or any other signal) present on the **landing page** keeps the visitor
eligible on a **later page** that no longer carries it.

The session is a **30-minute sliding window** by default (re-touching resets the
expiry); override it with the `sessionLengthSec` option on `createTestaProxy`.
The same window governs the exclusion cooldown for visitors who don't qualify.

Conditions are **grouped by dimension**: **OR within a dimension** (any rule of
that dimension may pass) and **AND across dimensions** (every dimension in the
targeting set must pass). Exclusion rules are the inverse — if **any** exclusion
condition matches, the visitor is excluded.

---

## API reference

### `createTestaProxy(options)`

Returns a Next.js proxy/middleware function. Import from `@testa-soft/next`.

| Option               | Type                                            | Default                          | Description                                                                          |
| -------------------- | ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `projectId`          | `string`                                        | —                                | **Required.** Your crobot project UUID. Config is fetched from `{host}/api/v1/config/{projectId}`. |
| `projectSlug`        | `string`                                        | —                                | *Deprecated* alias for `projectId`.                                                  |
| `config`             | `ProjectConfig`                                 | —                                | Static config. Zero-latency; wins over `configUrl`/`loadConfig`.                     |
| `configUrl`          | `string`                                        | —                                | URL to fetch a `ProjectConfig` JSON from. Cached by TTL.                             |
| `loadConfig`         | `(projectId) => Promise<ProjectConfig \| null>` | —                                | Custom async config resolver (e.g. Edge Config). Cached by TTL.                      |
| `cacheTtlMs`         | `number`                                         | `30000`                          | Cache lifetime for fetched config.                                                   |
| `host`               | `string`                                         | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST`.                                            |
| `sessionLengthSec`   | `number`                                         | `1800` (30 min)                  | First-touch targeting cache / session / exclusion-cooldown window, in seconds.       |
| `secureCookies`      | `boolean`                                        | `true`                           | Emit `Secure` cookies. `false` for local http dev.                                   |
| `cookieDomain`       | `string`                                         | —                                | Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.example.com`).         |
| `discoverRootDomain` | `boolean`                                        | `false`                          | Auto-derive the registrable domain for cookies.                                      |
| `tracking`           | `boolean`                                        | `true`                           | Emit exposures so results populate. `false` for redirects-only, or if a pixel owns tracking. |
| `trackingHost`       | `string`                                         | `https://new.testa-soft.tech`    | Host for exposure tracking (`{trackingHost}/api/leads`). Also via `TESTA_TRACKING_HOST`. |
| `onVariationAssigned`| `(event, ctx) => void \| Promise<void>`         | —                                | **Server-side** hook per assignment. `ctx.waitUntil(promise)` keeps async work alive past the response — never delays it. Guard on `event.firstAssignment` for once-per-visitor. |

Exported constants: `DEFAULT_CONFIG_HOST`, `DEFAULT_TRACKING_HOST`,
`SHIELD_HEADER`. Exported types: `TestaProxy`, `TestaProxyOptions`,
`VariationHookContext`, `VariationAppliedEvent` (the server hook's `event`).

### Client event bus — `@testa-soft/next`

| Export                          | Signature                                          | Description                                                        |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `testa.onVariationApplied`      | `(handler) => Unsubscribe`                         | Subscribe to `variation_applied`. Multiple handlers; history replay. |
| `testa.onVariationAssigned`     | `(handler) => Unsubscribe`                         | Subscribe to the client-mirrored `variation_assigned`.            |
| `onVariationApplied`            | `(handler) => Unsubscribe`                         | Standalone equivalent of `testa.onVariationApplied`.              |
| `onVariationAssigned`           | `(handler) => Unsubscribe`                         | Standalone equivalent of `testa.onVariationAssigned`.            |
| `window.testa`                  | `{ onVariationApplied, onVariationAssigned }`      | Same API for GTM Custom HTML / non-bundled scripts.               |

The handler receives a `VariationEvent`: `{ project_id, experiment, variation, uuid, title, url }`.

### `<TestaProvider>` — `@testa-soft/next/server` (recommended)

Async React **Server Component**. Fetches the project config server-side on the
first request and caches it in the Next data cache, then renders the client
applier. Fails open (renders nothing) when the config can't be resolved.

| Prop            | Type            | Default                          | Description                                                          |
| --------------- | --------------- | -------------------------------- | -------------------------------------------------------------------- |
| `projectId`     | `string`        | —                                | **Required** (unless `config` given). Same id as `createTestaProxy`. |
| `config`        | `ProjectConfig` | —                                | Inline config — skips the fetch entirely.                             |
| `host`          | `string`        | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST` (matches the proxy).        |
| `revalidateSec` | `number`        | `30`                             | Next data-cache revalidation window for the config fetch.             |
| `previewApiUrl` | `string`        | —                                | Backend base URL; enables `?testa_preview`.                           |

### `<TestaGuard>` — `@testa-soft/next/server` (recommended)

Async React **Server Component**, self-gating: renders the anti-flicker script
**only** when the proxy set `x-testa-shield: 1` for this request (i.e. the
visitor has a pending DOM change on this page). Same props as the client
`<TestaGuard>` below. Renders nothing outside a request scope (static
generation) — fail open, no shield.

### `loadTestaConfig(options)` — `@testa-soft/next/server`

The config loader the server components use, exported for custom server code:
`loadTestaConfig({ projectId, host?, revalidateSec? })` → `Promise<ProjectConfig | null>`.
Fail-open: resolves `null` on any network/HTTP/shape failure.

### `<TestaProvider>` — `@testa-soft/next/experiments` (client entry)

| Prop            | Type            | Default | Description                                                        |
| --------------- | --------------- | ------- | ----------------------------------------------------------------- |
| `config`        | `ProjectConfig` | —       | **Required.** Same config the proxy uses.                         |
| `previewApiUrl` | `string`        | —       | Backend base URL; enables `?testa_preview`.                       |

### `<TestaGuard>` — `@testa-soft/next/experiments` (client entry)

| Prop        | Type                        | Default     | Description                                             |
| ----------- | --------------------------- | ----------- | ------------------------------------------------------ |
| `selector`  | `string`                    | `'body'`    | Selector to hide until reveal.                         |
| `timeoutMs` | `number`                    | `4000`      | Hard fallback before auto-reveal.                      |
| `mode`      | `'opacity' \| 'visibility'` | `'opacity'` | How to hide (`opacity` avoids reflow).                 |
| `styleId`   | `string`                    | —           | `<style>` element id — makes raising idempotent.       |

### `<TestaRouterGuard>` — `@testa-soft/next/router-guard`

| Prop     | Type            | Default | Description                          |
| -------- | --------------- | ------- | ------------------------------------ |
| `config` | `ProjectConfig` | —       | **Required.** Same config as above.  |

---

## Troubleshooting

**A DOM change flashes control before the variant.** Make sure `<TestaGuard/>` is
in `<head>` (not the body), so it runs before first paint. On App-Router *soft*
navigations there is no shield by design; the re-apply is near-instant.

**A change is applied then reverted.** React owns the DOM it renders. Prefer `css`
changes (injected into `<head>`, which React never reconciles) for anything
expressible as style; `css` survives every re-render.

**Split-URL loops or doesn't fire.** The redirect only enrolls on the experiment's
target page rule and never re-matches the destination URL. Check the experiment's
page rule and match type.

**No `variation_applied` event.** It fires **once per session** on the applied
page — a soft-nav re-apply or a re-render won't re-fire it. Register handlers
early, but history replay means a late handler still receives an event that
already fired.

**Nothing happens at all.** The proxy fails open when it can't resolve config —
confirm `projectId` (or `config`) is correct and the `matcher` includes your
route.

---

## How it works (architecture)

`@testa-soft/next` is a thin Next.js adapter over two shared, framework-neutral
packages:

- **`@testa-soft/experiment-core`** — the decision layer: deterministic bucketing,
  the packed `_testa_exp` cookie, split-URL redirect resolution, first-touch
  session targeting.
- **`@testa-soft/dom`** — the render layer: applying DOM changes, the anti-flicker
  shield, and the client-side event bus.

The same two packages back other framework integrations, so bucketing and
rendering behave identically everywhere a visitor might be seen.
