# @testa-soft/next

Next.js integration for [Testa](https://testa-soft.tech) A/B testing. It gives you two complementary experiment types from one package: **server-side, flicker-free split-URL redirects** driven by a single middleware, and **client-side HTML/DOM experiments** applied by React components with a built-in anti-flicker shield. Both read the same sticky `_testa_exp` cookie, so a visitor is bucketed once — server-side — and stays in the same variation across page loads, soft navigations, and experiment types.

## Install

```bash
npm install @testa-soft/next
```

Peer dependencies (you almost certainly already have these):

- `next` — `>=13.4.0`
- `react` — `>=18` (optional; only required if you use the client components under `@testa-soft/next/experiments` or `@testa-soft/next/router-guard`)

## Quick start — split-URL redirects

Split-URL tests send a bucketed visitor to a different URL. It's decided server-side and issued as a `307` **before any HTML is sent**, so there is no flicker and no client JS required.

Create `proxy.ts` at your project root (or under `src/`):

```ts
// proxy.ts
import { createTestaMiddleware } from '@testa-soft/next'

export const proxy = createTestaMiddleware({ projectId: '3fa85f64e1c2b' })

export const config = {
  // Run on real pages; skip Next internals, static assets, and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

> **Next.js version.** Next 16 renamed the middleware file convention to
> `proxy` — use `proxy.ts` with `export const proxy = …` (above). On **Next
> 13–15**, name the file `middleware.ts` and the export `middleware` instead;
> everything else is identical. `createTestaMiddleware` is unchanged either way.

That is the whole integration. `projectId` is your **crobot project UUID**. With
just `projectId`, the package fetches your project config from the built-in
config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`).

### Inline-config mode

If you'd rather ship the config yourself (local dev, a demo, or a deploy that
resolves config from its own source), pass a `config` object instead of relying
on the config host:

```ts
// proxy.ts  (Next 13–15: middleware.ts, export `middleware`)
import { createTestaMiddleware } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const proxy = createTestaMiddleware({
  projectId: '3fa85f64e1c2b',
  config: projectConfig, // a ProjectConfig — zero-latency, no network fetch
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
```

You can also point at a custom config host with `host: 'https://config.staging.example.com'`,
supply a `configUrl` to fetch from, or provide an async `loadConfig(projectId)`
resolver (e.g. read Vercel Edge Config). Fetched configs are cached (30s by
default, `cacheTtlMs`). If no config can be resolved, the middleware fails open
and passes the request through untouched.

## HTML/DOM experiments

For "same URL, different content" tests, Testa applies **crobot-native DOM
changes** on the client. The split is:

- **Middleware assigns** the visitor server-side and writes the sticky
  `_testa_exp` cookie (add the middleware from the quick start above — DOM
  experiments reuse the exact same assignment).
- **`<TestaExperiments/>` renders** that assignment on the client, cookie-first:
  it reads `_testa_exp`, looks up the variation's changes in the config, and
  applies them to the DOM. No re-bucketing happens on the client.

Because DOM changes mutate content the server already rendered (the control),
there's an unavoidable control→variant flash unless the page is hidden until the
variant is applied. `<TestaShield/>` handles that: it's a synchronous inline
`<head>` script that hides the content **before first paint** (with a hard
timeout fallback so a slow or broken apply can never leave the page blank), and
`<TestaExperiments/>` reveals it once the variant is on the page.

Add both in your root layout — the shield as high in `<head>` as possible, and
the experiments component anywhere in the body:

```tsx
// app/layout.tsx
import { TestaShield, TestaExperiments } from '@testa-soft/next/experiments'
import projectConfig from './testa.config.json'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Hides the page before paint; revealed once the variant is applied. */}
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

Supported change types are crobot-native and applied by the shared DOM engine:

| Change type            | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `change_html`          | Set matched elements' `innerHTML` to `content`.                    |
| `css`                  | Inject a `<style>` with `content` (optionally `global`).           |
| `hide_element`         | `display:none` on matched elements.                               |
| `append_html`          | `insertAdjacentHTML('beforeend', content)` on matched elements.    |
| `prepend_html`         | `insertAdjacentHTML('afterbegin', content)` on matched elements.   |
| `move_element_append`  | Move matched elements under the target selector (append).          |
| `move_element_prepend` | Move matched elements under the target selector (prepend).         |

> Split-URL-only deployments don't need `<TestaShield/>` — the middleware's
> `307` is already flicker-free. The shield only matters when you apply DOM
> changes on top of server-rendered content.

## Preview mode

Editors can preview **unpublished** variation drafts live, without them going to
real visitors. Pass `previewApiUrl` (your crobot backend base URL) to
`<TestaExperiments/>`:

```tsx
<TestaExperiments config={projectConfig} previewApiUrl="https://new.testa-soft.tech" />
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode `<TestaExperiments/>` **skips normal cookie assignment** and
instead fetches the draft changes for that session from
`{previewApiUrl}/api/preview/{token}` and applies them. The fetched changes are
the same crobot-native `VariationChange` shapes as real variations, so a draft
renders identically to how it will ship. A failed or malformed response applies
nothing and reveals the shield (fail-safe).

## Pages Router soft navigation

Client-side navigations in the **Pages Router** (static `next/link` navs) never
hit the server, so the middleware can't see them. `<TestaRouterGuard/>` is an
optional catch-all that closes that gap. Add it once in your Pages-Router layout
(e.g. `_app`):

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

It is cookie-first, just like the middleware: it reads the sticky `_testa_exp`
assignment (no re-roll, no config re-fetch) and, on a navigation to a control
URL for a split-URL experiment the visitor is bucketed to a variant of, aborts
the in-flight navigation and `router.replace()`s to the variant before the
control page renders. A visitor gets the same variant whether the middleware or
the guard fires — both read the one cookie.

> App Router users don't need this — `<TestaExperiments/>` re-applies DOM
> experiments on soft navigation, and the middleware handles split-URL
> redirects (including a prefetch-safe path for `<Link>` prefetches).

## API reference

### `createTestaMiddleware(options)`

Returns a Next.js middleware function. Import from `@testa-soft/next`.

| Option               | Type                                          | Default                              | Description                                                                                                    |
| -------------------- | --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `projectId`          | `string`                                      | —                                    | **Required.** Your project id. Config is fetched from `{host}/api/v1/config/{projectId}`.                     |
| `projectSlug`        | `string`                                      | —                                    | _Deprecated_ alias for `projectId`.                                                                          |
| `config`             | `ProjectConfig`                               | —                                    | Static config object. Zero-latency, no network fetch. Wins over `configUrl` / `loadConfig`.                   |
| `configUrl`          | `string`                                      | —                                    | URL to fetch a `ProjectConfig` JSON from. Cached by TTL.                                                      |
| `loadConfig`         | `(projectId) => Promise<ProjectConfig \| null>` | —                                  | Custom async config resolver (e.g. Edge Config). Cached by TTL.                                               |
| `cacheTtlMs`         | `number`                                       | `30000`                              | Cache lifetime for `configUrl` / `loadConfig` results.                                                       |
| `host`               | `string`                                       | `https://config.testa-soft.tech`     | Config host. Also settable via the `TESTA_CONFIG_HOST` env var. Override for local/staging.                   |
| `secureCookies`      | `boolean`                                      | `true`                               | Emit `Secure` cookies. Set `false` for local http dev.                                                       |
| `cookieDomain`       | `string`                                       | —                                    | Explicit cookie `Domain` for cross-subdomain tracking (e.g. `.example.com`). Wins over `discoverRootDomain`.     |
| `discoverRootDomain` | `boolean`                                      | `false`                              | Auto-derive the registrable domain from the request host for cookies.                                        |
| `tracking`           | `boolean`                                      | `true`                               | Emit exposures (impressions) so experiment results populate. Set `false` for redirects-only, or if a pixel owns tracking. |
| `trackingHost`       | `string`                                       | `https://new.testa-soft.tech`        | Host for exposure tracking (`{trackingHost}/api/leads`). Also settable via the `TESTA_TRACKING_HOST` env var. |
| `onVariationApplied` | `(event) => void \| Promise<void>`            | —                                    | Called for each variation applied on a request. Errors/rejections are swallowed; not awaited — keep it fast.  |

Exported constants: `DEFAULT_CONFIG_HOST`, `DEFAULT_TRACKING_HOST`. Exported
type: `VariationAppliedEvent` (the argument to `onVariationApplied`).

### `<TestaExperiments>` — from `@testa-soft/next/experiments`

| Prop            | Type            | Default | Description                                                                                          |
| --------------- | --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `config`        | `ProjectConfig` | —       | **Required.** The same config the middleware uses (local fixture or fetched once).                 |
| `previewApiUrl` | `string`        | —       | Backend base URL for preview mode. Required for `?testa_preview` to fetch drafts; ignored otherwise. |

### `<TestaShield>` — from `@testa-soft/next/experiments`

| Prop        | Type                        | Default     | Description                                                                                   |
| ----------- | --------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `selector`  | `string`                    | `'body'`    | CSS selector to hide until reveal.                                                            |
| `timeoutMs` | `number`                    | `4000`      | Hard fallback (ms) after which the shield auto-reveals no matter what.                        |
| `mode`      | `'opacity' \| 'visibility'` | `'opacity'` | How to hide. `opacity` keeps layout (no reflow on reveal).                                    |
| `styleId`   | `string`                    | —           | `<style>` element id — makes raising idempotent and reveal targeted.                          |

### `<TestaRouterGuard>` — from `@testa-soft/next/router-guard`

| Prop     | Type            | Default | Description                                                                          |
| -------- | --------------- | ------- | ----------------------------------------------------------------------------------- |
| `config` | `ProjectConfig` | —       | **Required.** The same config the middleware uses.                                  |

## How it works

- **Server-side assignment, cookie-first.** The middleware buckets each visitor
  deterministically and writes the sticky `_testa_exp` cookie (plus a `_testa`
  visitor id). Every surface — middleware, `<TestaExperiments/>`,
  `<TestaRouterGuard/>` — reads that one cookie, so a visitor sees the same
  variation everywhere with no re-rolling.
- **Split-URL is a `307` before HTML.** For split-URL experiments the middleware
  redirects at the edge before any markup is sent, so there is no flash and no
  client JS needed. `<Link>` prefetches (RSC requests) are handled specially: the
  prefetch is redirected to warm the variant into the router cache, but no cookie
  is written and no exposure is emitted until a real navigation commits.
- **DOM changes apply on the client, behind a shield.** For same-URL experiments
  `<TestaExperiments/>` applies the assigned variation's DOM changes after
  hydration and re-applies on App-Router soft navigation. `<TestaShield/>` hides
  the page before first paint so control content is never shown before the
  variant, and reveals it once the variant is applied (or after the timeout).
- **Exposures feed results.** When tracking is enabled, the middleware emits one
  exposure per fresh enrollment to the tracking host so experiment results
  populate; it's deduped server-side.
```
