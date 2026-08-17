# Testa for Next.js (`@testa-soft/next`)

Run Testa A/B experiments in a Next.js app with **one middleware and (optionally)
two components**. You get two kinds of experiments from a single integration:

- **Split-URL redirects** — send a bucketed visitor to a different URL. Decided
  server-side in middleware and issued as a `307` **before any HTML is sent**, so
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

> **Pre-release.** Testa/Next is currently published as a `0.0.x` pre-release, so
> `npm install @testa-soft/next` pulls the current build (its `@testa-soft/experiment-core`
> and `@testa-soft/dom` dependencies come along automatically).

---

## Concepts

**Server assigns, everything else follows.** The middleware runs on every matched
request, buckets the visitor deterministically (a stable hash of their id — never
`Math.random()`, so no sample-ratio mismatch), and writes the sticky `_testa_exp`
cookie. From then on every surface — the middleware, the client components — just
*reads* that cookie. Nobody re-rolls the dice.

**Split-URL is flicker-free by construction.** The redirect happens at the edge
before markup is streamed, so the control page is never painted.

**HTML changes happen on the client, behind a shield.** DOM changes have to mutate
content the server already rendered, so there's an unavoidable control→variant
moment. The shield hides the page until the variant is applied.

---

## Split-URL experiments

Create `middleware.ts` at your project root (or under `src/`):

```ts
// middleware.ts
import { createTestaMiddleware } from '@testa-soft/next'

export const middleware = createTestaMiddleware({ projectId: 'your-project-id' })

export const config = {
  // Run on real pages; skip Next internals, static assets, and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

That is the entire integration for split-URL. With just `projectId`, the package
fetches your project config from the Testa config host and caches it. A bucketed
visitor is redirected server-side; everyone else passes through untouched. If no
config can be resolved, the middleware **fails open** and does nothing.

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
import { createTestaMiddleware } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const middleware = createTestaMiddleware({
  projectId: 'your-project-id',
  config: projectConfig,
})
```

---

## HTML/DOM experiments

Add two components to your root layout: `<TestaShield/>` as high in `<head>` as
possible, and `<TestaExperiments/>` in the body. Keep the middleware too — DOM
experiments reuse its server-side assignment.

```tsx
// app/layout.tsx
import { TestaShield, TestaExperiments } from '@testa-soft/next/experiments'
import projectConfig from './testa.config.json'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Hides the page before first paint; revealed once the variant applies. */}
        <TestaShield selector="body" timeoutMs={4000} />
      </head>
      <body>
        {children}
        {/* Reads _testa_exp and applies the assigned variation's DOM changes.
            Re-applies automatically on App-Router soft navigation. */}
        <TestaExperiments config={projectConfig} />
      </body>
    </html>
  )
}
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

> Split-URL-only deployments don't need `<TestaShield/>` — the `307` is already
> flicker-free. The shield only matters when applying DOM changes on top of
> server-rendered content.

### Preview mode (for editors)

Preview **unpublished** variation drafts without exposing them to real visitors.
Pass `previewApiUrl` (your Testa backend base URL) to `<TestaExperiments/>`:

```tsx
<TestaExperiments config={projectConfig} previewApiUrl="https://app.testa-soft.tech" />
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
reach the server, so the middleware can't see them. `<TestaRouterGuard/>` is an
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

> **App Router users don't need this.** `<TestaExperiments/>` re-applies DOM
> experiments on soft navigation, and the middleware handles split-URL redirects
> (including a prefetch-safe path for `<Link>` prefetches).

---

## API reference

### `createTestaMiddleware(options)`

| Option               | Type                                            | Default                          | Description                                                                          |
| -------------------- | ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `projectId`          | `string`                                        | —                                | **Required.** Your project id.                                                       |
| `config`             | `ProjectConfig`                                 | —                                | Static config. Zero-latency; wins over `configUrl`/`loadConfig`.                     |
| `configUrl`          | `string`                                        | —                                | URL to fetch a `ProjectConfig` JSON from. Cached by TTL.                             |
| `loadConfig`         | `(projectId) => Promise<ProjectConfig \| null>` | —                                | Custom async config resolver (e.g. Edge Config). Cached by TTL.                      |
| `cacheTtlMs`         | `number`                                         | `30000`                          | Cache lifetime for fetched config.                                                   |
| `host`               | `string`                                         | built-in config host             | Config host. Also via `TESTA_CONFIG_HOST`.                                            |
| `secureCookies`      | `boolean`                                        | `true`                           | Emit `Secure` cookies. `false` for local http dev.                                   |
| `cookieDomain`       | `string`                                         | —                                | Explicit cookie `Domain` (e.g. `.acme.com`).                                          |
| `discoverRootDomain` | `boolean`                                        | `false`                          | Auto-derive the registrable domain for cookies.                                      |
| `tracking`           | `boolean`                                        | `true`                           | Emit exposures so results populate. `false` for redirects-only.                      |
| `trackingHost`       | `string`                                         | built-in tracking host           | Host for exposure tracking. Also via `TESTA_TRACKING_HOST`.                           |
| `onVariationApplied` | `(event) => void \| Promise<void>`              | —                                | Callback per applied variation. Errors swallowed; not awaited.                       |

### `<TestaExperiments>` — `@testa-soft/next/experiments`

| Prop            | Type            | Default | Description                                                        |
| --------------- | --------------- | ------- | ----------------------------------------------------------------- |
| `config`        | `ProjectConfig` | —       | **Required.** Same config the middleware uses.                    |
| `previewApiUrl` | `string`        | —       | Backend base URL; enables `?testa_preview`.                       |

### `<TestaShield>` — `@testa-soft/next/experiments`

| Prop        | Type                        | Default     | Description                                             |
| ----------- | --------------------------- | ----------- | ------------------------------------------------------ |
| `selector`  | `string`                    | `'body'`    | Selector to hide until reveal.                         |
| `timeoutMs` | `number`                    | `4000`      | Hard fallback before auto-reveal.                      |
| `mode`      | `'opacity' \| 'visibility'` | `'opacity'` | How to hide (`opacity` avoids reflow).                 |

### `<TestaRouterGuard>` — `@testa-soft/next/router-guard`

| Prop     | Type            | Default | Description                          |
| -------- | --------------- | ------- | ------------------------------------ |
| `config` | `ProjectConfig` | —       | **Required.** Same config as above.  |

---

## Troubleshooting

**A DOM change flashes control before the variant.** Make sure `<TestaShield/>` is
in `<head>` (not the body), so it runs before first paint. On App-Router *soft*
navigations there is no shield by design; the re-apply is near-instant.

**A change is applied then reverted.** React owns the DOM it renders. Prefer `css`
changes (injected into `<head>`, which React never reconciles) for anything
expressible as style; `css` survives every re-render.

**Split-URL loops or doesn't fire.** The redirect only enrolls on the experiment's
target page rule and never re-matches the destination URL. Check the experiment's
page rule and match type.

**Nothing happens at all.** The middleware fails open when it can't resolve config
— confirm `projectId` (or `config`) is correct and the `matcher` includes your
route.

---

## How it works (architecture)

`@testa-soft/next` is a thin Next.js adapter over two shared, framework-neutral
packages:

- **`@testa-soft/experiment-core`** — the decision layer: deterministic bucketing,
  the packed `_testa_exp` cookie, split-URL redirect resolution, targeting.
- **`@testa-soft/dom`** — the render layer: applying DOM changes + the anti-flicker
  shield.

The same two packages back other framework integrations (a client SDK for
Vite/React SPAs is on the roadmap), so bucketing and rendering behave identically
everywhere a visitor might be seen.
