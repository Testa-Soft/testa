# PRD 005 — Pixel 4.0 Distribution (`/projects/{X}.js` over config host)

> Status: **needs-triage**
> Author: Claude (from 2026-08-20 session with Mantas)
> Depends on: PRD 001 (collector ingest), config API (collector `POST/GET /api/v1/config/{projectId}`), testa-config-geo worker
> Related: PRD 004 (remote client runtime for npm SDK customers — shares the pixel runtime and the versioning/pinning model)

## Problem Statement

Customers who don't run React or Next.js have no 4.0 integration at all. The
legacy 3.3.3 integration — one `<script src="https://cdn.testa-soft.tech/projects/{X}.js">`
tag with the project's config baked into the script — is served by crobot,
built from the old codebase, and receives none of the 4.0 work: deterministic
bucketing, the new goal tracking, the events schema, audience targeting, the
redirect engine. Every improvement made in this repo is invisible to the
majority integration path, and the pixel we *have* built here
(the loader + runtime in this repo) has no distribution mechanism.

## Solution

Make the 4.0 pixel the standard integration for everyone not on
`@testa-soft/react` / `@testa-soft/next`, served with the same one-tag
developer experience as 3.3.3 — same URL shape, new host:

```html
<script src="https://config.testa-soft.tech/projects/{X}.js" defer></script>
```

Distribution pipeline, mirroring how 3.3.3's `script.js` worked but built and
managed in this repo:

1. **Deploy-time template build.** Each platform deploy builds the pixel
   template from this repo: the sync loader stub plus the runtime IIFE, with
   placeholders for the project id and the config JSON — the 4.0 equivalent of
   3.3.3's `script.js` template.
2. **Publish-time injection.** When crobot pushes a project's config to the
   collector (the existing config API hook), the collector — in addition to
   building the servable ProjectConfig — renders the final per-project pixel by
   injecting the config JSON into the current template, and uploads the
   artifact to R2 (keyed by project, config hash, and pixel version).
3. **Edge serving with geo injection.** A Cloudflare worker on
   `config.testa-soft.tech` serves `/projects/{X}.js` from R2, splicing the
   visitor's geo into the embedded config at request time — the same mechanism
   testa-config-geo already applies to the config JSON — with the same
   ETag / s-maxage / stale-while-revalidate caching and the existing
   publish-time cache purge extended to script URLs.

Because the config is baked in at publish and geo is spliced at the edge, the
pixel starts deciding on first parse with **zero extra round trips** — full
legacy parity on time-to-decision, which is what the anti-flicker story
depends on.

## User Stories

1. As a customer developer on any stack (WordPress, Shopify, Rails, plain
   HTML), I want to integrate Testa with one script tag, so that I can run
   experiments without adopting an npm package or a framework SDK.
2. As a customer developer, I want the script URL shape to match the legacy
   one (`/projects/{X}.js`), so that migrating from 3.3.3 is a host swap, not
   a re-integration.
3. As a visitor on a customer site, I want the pixel to decide my variation on
   first parse without extra network round trips, so that I never see the
   control flash before a variant.
4. As a Testa platform engineer, I want the pixel template built from this
   repo on every deploy, so that pixel behavior ships through the same CI,
   tests, and review as the rest of the platform.
5. As a Testa platform engineer, I want config publishes to atomically rebuild
   the served script, so that editors' changes go live on the next pageload
   without any manual step.
6. As a Testa platform engineer, I want served artifacts versioned in R2 by
   project, config hash, and pixel version, so that I can canary a new pixel
   on one project and roll back by flipping a pointer.
7. As an experiment editor, I want the served pixel to honor preview mode
   (`?testa_preview`), so that I can review drafts on any customer site
   exactly as on SDK sites.
8. As an analyst, I want exposures and conversions from pixel sites to land in
   the same crobot results as SDK traffic, so that results are comparable
   across integration types.
9. As a marketer running geo-targeted experiments, I want the visitor's geo
   spliced into the script response at the edge, so that country/region
   targeting works without a client-side geo lookup.
10. As a customer developer with a SPA (React Router, Vue, plain history API),
    I want the pixel to re-run on soft navigations, so that experiments fire on
    every route, not just the landing page.
11. As a customer developer, I want `window.Analytica.*` and
    `window.testa.pushEvent` preserved, so that existing GTM containers and
    custom-goal calls keep working after the 3.3.3 → 4.0 swap.
12. As a customer developer, I want the pixel to fail open when the script or
    config is malformed, so that an outage on Testa's side never breaks my
    site.
13. As a Testa operator, I want cache purge on publish plus SWR at the edge,
    so that publishes are live within a pageload while the CDN absorbs the
    traffic.
14. As a Testa operator, I want each customer's script served from the shared
    worker with per-project artifacts, so that one project's publish never
    invalidates another's cache.
15. As a compliance-conscious customer, I want the pixel to respect the
    project's consent mode before writing cookies or tracking, so that the
    integration is usable under GDPR/CCPA.
16. As an analyst, I want bot and crawler traffic excluded from exposures at
    the pixel level, so that results are not diluted by non-human traffic.
17. As a Testa platform engineer, I want the pixel to emit the 4.0 events
    schema (viewport, tracker_version, utm_*, client_ts) to the collector, so
    that pixel traffic feeds the funnel foundation from PRD 002.
18. As a support engineer, I want redirect breadcrumbs retrievable from the
    served pixel, so that SPA redirect escalations are debuggable in the field.

## Implementation Decisions

- **The pixel is a gateway, not a fork.** All decision and render logic stays
  in the shared packages (`experiment-core` for bucketing, assignment,
  redirect resolution, goals resolution; `dom` for variation apply, goal
  controller, event bus) — exactly as `@testa-soft/next` and `@testa-soft/react`
  consume them today. The pixel runtime already imports these; this PRD adds
  distribution, not parallel implementations. Where a gap forces a change to
  the shared core (new export, behavior tweak), that change is **consulted with
  Mantas first** — it affects three shipped surfaces at once. Pixel-only
  concerns (lifecycle, consent gating, legacy 3.3.3 rule parsing, UA facts,
  cross-domain, breadcrumbs) remain in the pixel app.
- **Template assembly is a deep, pure module**: `(template, projectId, config)
  → final script text`, deterministic and testable in isolation. Placeholders
  are structural (not string-replace on user data) so a config containing the
  placeholder token can't corrupt the script.
- **The collector owns publish-time rendering.** The existing config-publish
  endpoint gains a step: after building the servable ProjectConfig, render the
  pixel artifact and upload to R2. Publish stays atomic — config JSON and
  script artifact always correspond to the same config hash.
- **R2 is the artifact store; the worker is read-only.** Serving never renders;
  it fetches the artifact, splices geo into the embedded config (reusing the
  splice approach from the config-geo worker), and sets cache headers. Cache
  key includes the config hash so publish + purge can never serve a stale mix.
- **Pixel version pinning per project.** The artifact key and a per-project
  pointer allow canary and rollback; this is the same pinning model PRD 004
  defines for the SDK runtime pointer — one mechanism, two consumers.
- **The template is the loader + runtime already in this repo** — the sync
  loader stub (queue + history monkey-patch, <5 KB) and the runtime IIFE. No
  new client code paths; distribution only.
- **Anti-flicker stays the customer SmartCode's job** (per the existing pixel
  boundary decision): the served script fires `_testa.load()`; the optional
  inline hide/reveal snippet remains a separate documented copy-paste.
- **Runtime completeness gates GA** (existing known gaps, tracked as part of
  this PRD's milestone rather than silently shipped): the legacy `targeting[]`
  evaluator, the sandboxed custom-JS audience evaluator, `visitor.custom`
  re-enable, the relative exact-mode `from_url` redirect no-match, and the SPA
  redirect repro harness with breadcrumbs.
- **Old host untouched.** `cdn.testa-soft.tech/projects/{X}.js` (crobot-served
  3.3.3) keeps working; migration is opt-in per project by swapping the host in
  the tag. No proxying or redirecting between the hosts.

## Testing Decisions

Good tests here assert **external behavior**: the text of the served script, the
HTTP semantics of the worker, and what a real browser does with the result —
never the internals of the renderer or the worker's code structure.

- **Template assembly (unit):** rendering with a given config yields a script
  that parses, embeds exactly that config, and survives adversarial configs
  (placeholder tokens, script-closing sequences, huge payloads). Prior art:
  the collector's config-build unit tests.
- **Publish flow (integration):** a config POST produces both the servable
  config and a matching R2 artifact; hash mismatch is impossible to observe.
  Prior art: collector route tests.
- **Worker serving (unit against the worker runtime):** correct
  content-type/ETag/cache headers, geo splice output, 404 semantics for
  unknown projects, purge behavior. Prior art: the config-geo worker tests.
- **Loader ↔ runtime handshake (unit):** queued `_testa.*` calls before runtime
  hydration replay correctly. Prior art: existing pixel loader tests.
- **End-to-end (Playwright):** a real page loading the served script assigns,
  applies a DOM change, redirects a split-URL variant, and emits an exposure —
  the whole chain against a local worker + fixture artifact. Prior art: the
  pixel's existing e2e harness.

## Out of Scope

- The npm-SDK remote runtime and loader handshake (PRD 004) — same runtime and
  pinning model, separate integration surface and PRD.
- Deprecating or proxying the legacy `cdn.testa-soft.tech` host.
- The visual editor / SmartCode generator UI in crobot (it only needs to print
  the new URL).
- Per-customer edge workers (the existing per-client worker decision covers
  tracking gateways, not script serving — serving is one shared worker).
- Self-hosted / first-party-domain script serving (CNAME onto customer
  domains) — worth a future PRD if customers ask.

## Further Notes

**SDK known-gap fast-follows** (apply to `@testa-soft/react` / `@testa-soft/next`
as released in 1.1.0, and to the pixel runtime where noted — small,
independent, sequenced after this PRD's serving work):

1. **`consent_mode` is not honored by the SDKs.** The pixel has a consent
   module; the react/next SDKs read the field from ProjectConfig but never gate
   cookies or tracking on it. Port the pixel's consent gating into the shared
   layer so all three surfaces behave identically.
2. **No bot/crawler skip on client-side exposures.** SDK exposures fire for
   headless and crawler traffic; results dilution. Port the 3.3.3 crawler
   check (as specced for page_view in PRD 002) into the shared exposure path.
3. **Legacy `targeting[]` evaluator** is still unbuilt (4.0 `audience` rules
   ship; configs carrying only legacy targeting silently target everyone).
   Needed for migrated 3.3.3 projects on any 4.0 surface.

The marketing site's own integrations (testa-marketing-next on `@testa-soft/next`,
native-landing on the pixel) should dogfood this pipeline as the first canary
projects.
