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
import { createTestaProxy } from '@testa-soft/next'

export const proxy = createTestaProxy({ projectId: '3fa85f64e1c2b' })
```

> **Next.js version.** Next 16 renamed the middleware file convention to
> `proxy` — use `proxy.ts` with `export const proxy = …` (above). On **Next
> 13–15**, name the file `middleware.ts` and the export `middleware` instead;
> everything else is identical. `createTestaProxy` is unchanged either way.

That is the whole integration. `projectId` is your **crobot project UUID**. With
just `projectId`, the package fetches your project config from the built-in
config host (`https://config.testa-soft.tech/api/v1/config/{projectId}`).

The proxy is safe on **every** request out of the box: it internally passes
through `/_next/*`, `/api/*`, `/.well-known/*`, and static-asset files (images,
fonts, scripts, `robots.txt`, …) without touching cookies, fetching config, or
emitting exposures — no `matcher` needed for correctness.

### Optional: skip invocations with a `matcher`

A `matcher` saves the middleware **invocation itself** on asset requests (edge
invocations cost money and add latency on some hosts). It's purely a cost
optimization — if the regex is wrong or missing, nothing misbehaves:

```ts
// proxy.ts — optional, saves edge invocations on assets
export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|sitemap.xml|robots.txt).*)'],
}
```

> Next.js requires `matcher` to be a static literal in **your** file (it's
> parsed at build time), so the package can't provide it for you. Keep it
> conservative: a path the matcher skips is a path Testa can never test on.
> To exclude extra routes from experiments, prefer the `skipPaths` option —
> it lives in one place and takes regexes.

### Inline-config mode

If you'd rather ship the config yourself (local dev, a demo, or a deploy that
resolves config from its own source), pass a `config` object instead of relying
on the config host:

```ts
// proxy.ts  (Next 13–15: middleware.ts, export `middleware`)
import { createTestaProxy } from '@testa-soft/next'
import projectConfig from './testa.config.json'

export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  config: projectConfig, // a ProjectConfig — zero-latency, no network fetch
})
```

You can also point at a custom config host with `host: 'https://config.staging.example.com'`,
supply a `configUrl` to fetch from, or provide an async `loadConfig(projectId)`
resolver (e.g. read Vercel Edge Config). Config caching (`cache` option), shared per server instance:

- `true` (default) — fresh for 60s, then served stale while revalidating in the
  background (never older than 5 min): zero request latency, publishes live in
  ~1 min. `cacheTtlMs` tunes the fresh window.
- `'per-pageload'` — DOCUMENT requests always fetch fresh (a publish is live on
  the very next hard pageview); RSC soft navigations reuse the pinned copy, so
  the config never shifts mid-SPA-session.
- `false` — no server-side cache; every request fetches (testing only). If no config can be resolved, the middleware fails open
and passes the request through untouched.

## Composing with your own middleware

Next.js runs **one** middleware and allows **one** response — and request-header
overrides (`NextResponse.next({ request: { headers } })`) travel on that
response as a wholesale set. Two separately-built responses can never be merged
by hand, so if you already have middleware logic (auth, locale, custom headers),
compose it with the proxy in one of two ways.

### Your logic inside the proxy — the `handler` option (recommended)

```ts
export const proxy = createTestaProxy({
  projectId: '3fa85f64e1c2b',
  handler: (req, event) => {
    // Your middleware logic. `req.headers` already carries x-testa-shield —
    // clone them when overriding request headers, as you normally would:
    const headers = new Headers(req.headers)
    headers.set('x-domain', 'acme.com')
    return NextResponse.next({ request: { headers } })
  },
})
```

Semantics:

- Requests testa bypasses (`/api/*`, assets, `skipPaths`) go **straight to your
  handler**, so your headers still reach API routes.
- A split-URL redirect short-circuits — your handler is not called (nothing
  downstream renders). A redirect **you** return wins on pass-through requests
  and gets testa's cookies.
- On pass-through, testa merges its cookies onto your response and re-patches
  the `x-testa-shield` override even if you return a plain `NextResponse.next()`
  or `undefined`.

### The proxy inside your middleware (outer wrapper)

If you'd rather own the outer function — e.g. to short-circuit before testa
runs — call the proxy and post-process its response. Response headers and
cookies merge fine with standard APIs; for **request**-header overrides use the
exported `applyRequestHeaders` (it appends to the proxy's override set instead
of clobbering it):

```ts
import { applyRequestHeaders, createTestaProxy } from '@testa-soft/next'

const testa = createTestaProxy({ projectId: '3fa85f64e1c2b' })

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (isMaintenanceMode()) return NextResponse.rewrite(new URL('/down', req.url))

  const res = await testa(req, event) // forward `event` — tracking uses waitUntil
  res.headers.set('x-frame-options', 'DENY') // response headers merge trivially
  return applyRequestHeaders(res, { 'x-domain': 'acme.com' }, req)
}
```

`applyRequestHeaders(res, headers, req)` is a no-op on redirects, appends when
the response already carries an override set, and seeds the full set from
`req.headers` otherwise (pass `req` — override semantics are wholesale, and
seeding only your headers would drop every other request header downstream).

## HTML/DOM experiments

For "same URL, different content" tests, Testa applies **crobot-native DOM
changes** on the client. The split is:

- **Middleware assigns** the visitor server-side and writes the sticky
  `_testa_exp` cookie (add the middleware from the quick start above — DOM
  experiments reuse the exact same assignment).
- **`<TestaProvider/>` renders** that assignment on the client, cookie-first:
  it reads `_testa_exp`, looks up the variation's changes in the config, and
  applies them to the DOM. No re-bucketing happens on the client.

Because DOM changes mutate content the server already rendered (the control),
there's an unavoidable control→variant flash unless the page is hidden until the
variant is applied. `<TestaGuard/>` handles that: it's a synchronous inline
`<head>` script that hides the content **before first paint** (with a hard
timeout fallback so a slow or broken apply can never leave the page blank), and
`<TestaProvider/>` reveals it once the variant is on the page.

Add both in your root layout — the shield as high in `<head>` as possible, and
the experiments component anywhere in the body. Use the **server entry**: the
config is fetched server-side on the first request and cached in the Next data
cache (background-revalidated) — no app-side fetch code:

```tsx
// app/layout.tsx
import { TestaGuard, TestaProvider } from '@testa-soft/next/server'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Self-gating: renders the shield ONLY when the middleware flagged a
            pending DOM change for this request (x-testa-shield header). */}
        <TestaGuard selector="body" timeoutMs={4000} />
      </head>
      <body>
        {children}
        {/* Fetches the config server-side (same id as the proxy), then applies
            the assigned variation's DOM changes client-side. Re-applies on
            App-Router soft navigation. Fails open if config is unreachable. */}
        <TestaProvider projectId="3fa85f64e1c2b" />
      </body>
    </html>
  )
}
```

Managing the config yourself? The client entry
(`@testa-soft/next/experiments`) exports the same components taking an explicit
`config` prop (the shield there always renders — not header-gated), and the
`/server` components also accept `config` to skip their fetch.

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

> Split-URL-only deployments don't need `<TestaGuard/>` — the middleware's
> `307` is already flicker-free. The shield only matters when you apply DOM
> changes on top of server-rendered content.

## Preview mode

Editors can preview **unpublished** variation drafts live, without them going to
real visitors. Pass `previewApiUrl` (your crobot backend base URL) to
`<TestaProvider/>`:

```tsx
<TestaProvider config={projectConfig} previewApiUrl="https://new.testa-soft.tech" />
```

Then open any page with the preview query params:

```
https://yoursite.com/pricing?testa_preview=true&testa_preview_token=<token>
```

In preview mode `<TestaProvider/>` **skips normal cookie assignment** and
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

> App Router users don't need this — `<TestaProvider/>` re-applies DOM
> experiments on soft navigation, and the middleware handles split-URL
> redirects (including a prefetch-safe path for `<Link>` prefetches).

## API reference

### `createTestaProxy(options)`

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
| `skipPaths`          | `(string \| RegExp)[]`                         | —                                    | Extra paths to pass through untouched, on top of the built-in filter (`/_next/*`, `/api/*`, `/.well-known/*`, asset extensions). Strings match as segment-aligned prefixes (`'/admin'` matches `/admin/users`, not `/administrator`); RegExps test the pathname. |
| `handler`            | `(req, event) => Response \| null \| undefined \| Promise<…>` | —                     | Your own middleware logic, composed inside the proxy — see [Composing with your own middleware](#composing-with-your-own-middleware). |
| `onVariationAssigned`| `(event, ctx) => void \| Promise<void>`       | —                                    | **Server-side** hook per assignment. `ctx.waitUntil(promise)` keeps async work (PostHog server, webhook) alive past the response — never delays it. Guard on `event.firstAssignment` for once-per-visitor. |

Exported constants: `DEFAULT_CONFIG_HOST`, `DEFAULT_TRACKING_HOST`. Exported
type: `VariationAppliedEvent` (the argument to `onVariationAssigned`).

## Analytics events (GA4 / GTM / PostHog / Segment)

Two independent surfaces — use either or both:

**Client-side** — the SDK fires **`variation_applied`** in the browser once per
session when a visitor is shown a variation (after the redirect for split-URL, on
the page for DOM). Subscribe with named functions (multiple handlers allowed;
each returns an unsubscribe), or `window.testa`:

```ts
import { testa } from '@testa-soft/next'

const off = testa.onVariationApplied((d) => posthog.capture('$experiment_viewed', d))
testa.onVariationApplied((d) => segment.track('Experiment Viewed', d))
// d = { project_id, experiment, variation, uuid, title, url }
```

A handler registered **after** the event fired still receives it (history
replay), so late-loading analytics don't miss it. `window.testa.onVariationApplied`
is also installed for GTM Custom HTML / non-bundled scripts.

**GTM `dataLayer`** — pushed automatically (no config) on every `variation_applied`:

```js
{ event: 'Analytica', ExperimentId, ExperimentName, VariationId, VariationName }
```
Add a GTM **Custom Event** trigger on `Analytica`.

**Server-side** — for PostHog server, a warehouse, or webhooks, use the
`onVariationAssigned` proxy option (above) with `ctx.waitUntil`. It's independent
of the client surface — wire up both if you want.

> `variation_assigned` = when the visitor is bucketed (server); `variation_applied`
> = when they're shown it (client, once per session). Both carry the same payload.

### `<TestaProvider>` — from `@testa-soft/next/server` (recommended)

Async server component: fetches the config server-side (Next data cache) and
renders the client applier. Fails open (renders nothing) on any config failure.

| Prop            | Type            | Default                          | Description                                                           |
| --------------- | --------------- | -------------------------------- | --------------------------------------------------------------------- |
| `projectId`     | `string`        | —                                | **Required** (unless `config` given). Same id as `createTestaProxy`.  |
| `config`        | `ProjectConfig` | —                                | Inline config — skips the fetch.                                       |
| `host`          | `string`        | `https://config.testa-soft.tech` | Config host. Also via `TESTA_CONFIG_HOST`.                             |
| `revalidateSec` | `number`        | `30`                             | Next data-cache revalidation window.                                   |
| `previewApiUrl` | `string`        | —                                | Backend base URL; enables `?testa_preview`.                            |

### `<TestaGuard>` — from `@testa-soft/next/server` (recommended)

Async server component with the same props as the client shield below, but
**self-gating**: renders only when the middleware set `x-testa-shield: 1` for
this request. Outside a request scope (static generation) it renders nothing.

`loadTestaConfig({ projectId, host?, revalidateSec? })` is also exported from
`/server` for custom server code — resolves `null` on any failure (fail open).

### `<TestaProvider>` — from `@testa-soft/next/experiments` (client entry)

| Prop            | Type            | Default | Description                                                                                          |
| --------------- | --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `config`        | `ProjectConfig` | —       | **Required.** The same config the middleware uses (local fixture or fetched once).                 |
| `previewApiUrl` | `string`        | —       | Backend base URL for preview mode. Required for `?testa_preview` to fetch drafts; ignored otherwise. |

### `<TestaGuard>` — from `@testa-soft/next/experiments` (client entry)

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
  visitor id). Every surface — middleware, `<TestaProvider/>`,
  `<TestaRouterGuard/>` — reads that one cookie, so a visitor sees the same
  variation everywhere with no re-rolling.
- **Split-URL is a `307` before HTML.** For split-URL experiments the middleware
  redirects at the edge before any markup is sent, so there is no flash and no
  client JS needed. `<Link>` prefetches (RSC requests) are handled specially: the
  prefetch is redirected to warm the variant into the router cache, but no cookie
  is written and no exposure is emitted until a real navigation commits.
- **DOM changes apply on the client, behind a shield.** For same-URL experiments
  `<TestaProvider/>` applies the assigned variation's DOM changes after
  hydration and re-applies on App-Router soft navigation. `<TestaGuard/>` hides
  the page before first paint so control content is never shown before the
  variant, and reveals it once the variant is applied (or after the timeout).
- **Exposures feed results.** When tracking is enabled, the middleware emits one
  exposure per fresh enrollment to the tracking host so experiment results
  populate; it's deduped server-side.
```
