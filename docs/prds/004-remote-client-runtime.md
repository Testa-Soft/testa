# PRD 004 — Remote Client-Side Runtime (CDN-served, loader-mounted)

> Status: **needs-triage**
> Author: Claude (from 2026-08-20 session with Mantas)
> Depends on: PRD 003 (Next.js middleware), goal-tracking work shipped in 0.0.2-dev.10

## Problem Statement

Every behavioral change to the client-side SDK — a goal-tracking fix, a new
change type, a timing tweak, a payload correction — is compiled into the
customer's application bundle at build time. Shipping it requires publishing a
new npm version AND every customer bumping the dependency, rebuilding, and
redeploying. Tonight's goal-tracking feature is the canonical example: no
customer gets it without moving to `0.0.2-dev.10` themselves.

The legacy 3.3.3 integration never had this problem: the script was served from
the CDN, so a re-publish reached every site on the next pageload. We want that
operational model back — adjust as much of the integration as possible
remotely, without clients touching package versions — while keeping the
server-side advantages (flicker-free middleware redirects, SSR-fetched config,
anti-flicker shield) that the npm SDKs added.

## Solution

Split the SDKs into a **thin npm loader** (the rarely-changing contract) and a
**CDN-served runtime** (the frequently-changing behavior):

- The npm package keeps only what physically must run in the customer's
  infrastructure: the middleware (edge redirects, assignment, cookie contract),
  the anti-flicker shield, and a small loader component.
- The loader injects one `<script>` from the same CDN that already serves the
  config JSON, and hands it the config + page context through a small,
  versioned `window` handshake: `mount(config, context) → teardown`.
- Everything client-side — DOM apply, goal tracking (page_view / click /
  custom), the event bus, `pushEvent` — lives in that runtime script. A
  re-publish of the runtime reaches every integrated site on its next pageload.
- The config JSON itself names the runtime file each project should load, so
  runtime rollout, pinning, canary, and rollback are all remote, per-project
  operations.

There is deliberately **no bundled fallback**: the runtime is served from the
same CDN as the config, so if the runtime is unreachable the config was
unreachable too and there is nothing to apply. The SDK fails open exactly as it
does today for a missing config — shield reveals, page renders untouched,
middleware redirects keep working because they are server-side.

## User Stories

1. As a Testa platform engineer, I want to fix a client-side bug (e.g. a goal
   selector edge case) by publishing a runtime file, so that every customer
   site picks it up on the next pageload without a package release.
2. As a Testa platform engineer, I want to add a new variation change type and
   have existing integrations render it, so that feature rollout does not wait
   on customer dependency bumps.
3. As a Testa platform engineer, I want the config JSON to pin which runtime
   version each project loads, so that I can canary a new runtime on one
   project before rolling it to all.
4. As a Testa platform engineer, I want to roll back a bad runtime by editing
   the project's runtime pointer, so that recovery takes seconds and no
   customer action.
5. As a customer developer, I want the npm package surface (components, props,
   exports) to stay stable across runtime updates, so that remote updates never
   break my build or my typechecks.
6. As a customer developer, I want the integration to fail open when the CDN is
   unreachable, so that a Testa outage can never blank or break my site.
7. As a customer developer, I want the middleware's server-side redirects to
   work even when the client runtime fails to load, so that split-URL
   experiments remain flicker-free and ad-block-proof.
8. As a customer developer, I want `pushEvent` importable from the npm package
   and working identically whether the runtime has loaded yet or not, so that
   my event calls never race the script injection.
9. As a marketer, I want experiments, goals, and targeting edited in crobot to
   behave identically before and after this refactor, so that the migration is
   invisible to me.
10. As a marketer, I want new goal behaviors (e.g. future "any matching
    element" click goals) to appear without asking the customer's dev team to
    upgrade, so that CRO iteration speed is not gated on client release cycles.
11. As a Testa operator, I want runtime files served hash-addressed with
    immutable long-lived caching, so that CDN cache behavior is deterministic
    and rollouts don't fight stale caches.
12. As a Testa operator, I want the runtime channel pointer resolved through
    the config JSON (which already has purge-on-publish), so that runtime
    rollout reuses the existing propagation machinery instead of a new one.
13. As a Testa operator, I want a version-skew contract between loader and
    runtime (old loader + new runtime must work), so that sites that never
    rebuild keep working for years.
14. As a security-conscious enterprise customer, I want to pin my project to an
    exact runtime hash, so that Testa cannot change executing code on my site
    without my knowledge.
15. As a Testa platform engineer, I want the pixel and the SDK runtime built
    from the same shared packages, so that behavior parity between integration
    modes is a build concern, not a reimplementation.
16. As a customer developer on a strict CSP, I want a documented single origin
    to allowlist for both config and runtime, so that adopting the SDK needs
    one CSP line.
17. As a Testa QA engineer, I want a demo that loads the real runtime through
    the real loader path, so that end-to-end regressions are caught before a
    runtime publish.

## Implementation Decisions

- **Runtime bundle**: a new build artifact assembled from the existing shared
  packages (`dom` apply engine + goal controller + event bus, `experiment-core`
  cookie/exposure/goal resolvers). It exposes exactly one entry:
  `mount(config, context) → teardown`, registered on a versioned `window`
  global. It performs NO assignment and NO redirects — cookie-first only; the
  middleware (or the pixel, in pixel-mode integrations) owns assignment. The
  pixel remains a separate, fuller bundle built from the same shared code.
- **Loader**: the client components in the Next and React SDKs
  (`TestaExperiments`, `TestaProvider`) become loaders: resolve config (as
  today), inject the runtime script, call `mount` per navigation, dispose the
  returned teardown on nav/unmount. Their public props do not change.
- **Handshake contract (the deep, frozen interface)**: a single versioned
  global carrying `mount`; the context argument carries current URL, visitor
  uuid, tracking host, and an events bridge. The npm-side `pushEvent` and
  `onVariationApplied`/`onVariationAssigned` are thin queue-until-mounted
  wrappers so customer calls never race script injection. Contract changes are
  additive-only; a breaking change requires a new global version name, and the
  runtime keeps serving old versions.
- **Runtime-channel resolution**: the served config JSON gains an optional
  runtime pointer (file/hash + channel). The loader uses it when present, else
  a default channel baked into the package. Because the config already has
  purge-on-publish and ~30s client revalidation, runtime rollout inherits that
  propagation with zero new invalidation machinery.
- **Serving**: runtime files are hash-addressed and immutable-cached on the
  same CDN/origin pair as the config API (Cloudflare in front, collector/R2
  behind). The channel pointer lives in the config, not in a mutable CDN path.
- **No bundled fallback** (user decision): runtime and config share CDN
  availability; if the runtime cannot load, fail open exactly like a missing
  config today (reveal shield, apply nothing, middleware redirects unaffected).
- **Conversion/exposure transports are runtime concerns**: the legacy
  `/api/leads` + `/api/leads/convert` POSTs move with the runtime, so payload
  or endpoint migrations (e.g. an eventual switch to the ClickHouse pipeline)
  become remote changes.
- **Migration**: existing bundled-runtime versions of the SDKs keep working;
  the loader lands as a minor version. Customers upgrade once to the loader
  version, and from then on behavioral updates are remote.

## Testing Decisions

Good tests here assert **external behavior at module boundaries** — what a
customer or the CDN observes — never internal call sequences. Prior art: the
`goal-tracking` suites added in dev.10 (mock `fetch`, assert the exact POST
payload), the `serve-kv` cache-header tests in the edge app, and the packed-
cookie round-trip tests in experiment-core.

All five modules get dedicated suites (user decision):

1. **Runtime mount contract** — mount with a config + context, assert DOM
   changes applied, goals armed (network POSTs on match), teardown reverses
   everything. Runs against the built bundle, not the source.
2. **Loader handshake** — mocked script injection: loader injects exactly one
   script per page, queues `pushEvent` calls made pre-mount and flushes them
   post-mount, disposes teardowns per navigation, fails open on script error.
3. **Channel resolution** — config with/without runtime pointer, pinned hash
   beats channel, malformed pointer falls back to package default.
4. **Serving/cache** — hash-addressed file gets immutable long-TTL headers;
   config (carrying the pointer) keeps its existing purge-on-publish headers.
5. **ABI version skew** — previous loader version against new runtime bundle:
   mount succeeds and events flow (additive-only contract enforced by test).

Plus a demo-level Playwright e2e (loads the real runtime through a local CDN
stub; verifies apply + a goal conversion end-to-end).

## Out of Scope

- Migrating conversion/exposure ingestion off the legacy crobot endpoints (the
  transport moves into the runtime; changing its destination is a later,
  now-remote change).
- Pixel-mode changes: the standalone pixel keeps its own bundle and lifecycle.
- Engine `mutex_group` enforcement, "any matching element" click goals, and
  other behavioral upgrades — they become easy *after* this ships, but are not
  part of it.
- A customer-facing UI for runtime pinning (config field + crobot plumbing
  only; UI later).
- Self-hosted runtime serving for enterprise customers.

## Further Notes

- The 3.3.3 CDN model is the operational north star, but the trust posture
  differs: hash-pinning (story 14) is the answer for customers who object to
  "Testa can change code on my site" — document it prominently.
- CSP guidance: one origin allowlisted covers config + runtime + conversion
  POSTs only if the tracking host is also consolidated; today conversions go to
  the crobot host — note this in integration docs.
- The loader version becomes the long-lived "contract" release; expect it to be
  the last version most customers ever install. Treat its API review
  accordingly.
