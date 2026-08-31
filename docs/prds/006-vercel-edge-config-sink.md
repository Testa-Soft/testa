# PRD 006 — Vercel Edge Config sink (zero-latency server decisions)

**Status:** draft — scope locked, ready to break into tasks
**Owner:** unassigned
**Date:** 2026-08-31
**Origin:** in-thread design 2026-08-31, from the cold-start flicker on a
customer's `hybrid` deployment. Extends
[[decision_config_api_single_source]] with an outbound write path; the
counterpart to [[decision_no_await_positioning]], which rejected paying for cold
starts on the request path.

---

## Problem statement

On Vercel the proxy runs in short-lived edge isolates spread across every
region. Our config cache is **per-isolate in-memory** (`ConfigClient`), so at any
moment an unknowable fraction of the fleet is cold. A cold isolate has two bad
options, and both are live today:

- **`decisions: 'hybrid'`** (default) — pass through and let the browser decide.
  The visitor's decision is now client-side: the shield goes up, a config fetch
  and a hydration happen, and only then does the variation apply. For a DOM/copy
  experiment that is the cold-start flicker; for a split-URL one it is a
  client-side `location.replace` instead of a `307`.
- **`decisions: 'server'`** — block the request on a config fetch, capped by
  `fetchTimeoutMs` (400ms). Correct decisions, paid for in TTFB, on a
  cross-continent hop to `config.testa-soft.tech`.

Warm isolates are already optimal: `cacheTtlMs` defaults to `0`, so every
request revalidates behind the response via `waitUntil`, with in-flight dedupe
and stale-fallback. **The cold read is the whole problem.**

You cannot fix this by warming the fleet. There is no addressable set of isolates
to warm, their lifetimes are not ours to control, and a cron that warms one
region tells you nothing about the next request's. The fix is to make a cold read
cost approximately nothing.

## What this is

Use **Vercel Edge Config** as the proxy's config source. It is replicated to
every region and colocated with compute: sub-millisecond p90 reads, propagation
in under ten seconds. A cold isolate pays ~1ms instead of a network fetch, which
makes `decisions: 'server'` safe as a default on Vercel — and that removes the
client-decided path entirely, along with its flicker.

The SDK already supports this. `TestaProxyOptions.loadConfig` is an async
resolver we cache by TTL, documented since day one as "e.g. read Vercel Edge
Config". **No engine or middleware change is required to READ.**

What does not exist is the **write**. This PRD is about getting a built
`ProjectConfig` into a customer's Edge Config store on every publish.

---

## Design decisions (locked)

### 1. testa-platform writes it, not crobot

crobot does not have the servable shape. `buildTestaConfig`
(`apps/collector/src/config/build.ts`) is what turns crobot's `ProjectResource`
into a `ProjectConfig`: it filters to `split_url` + `copy`, derives the redirect
`from_url` from the experiment URL, maps `url_match_type`, normalizes goals, and
computes `config_hash`. Writing Edge Config from crobot would mean porting all of
that to PHP and keeping two implementations in lockstep forever.

The existing pipeline already ends in the right place. One outbound step is added
after the store write:

```
crobot publish
  → POST /api/v1/config/{projectId}          (raw ProjectResource, Bearer-authed)
  → buildTestaConfig → ConfigStore            ← source of truth, unchanged
  → fan out to sinks                          ← NEW
      ├── Vercel Edge Config (this PRD)
      └── CF cache purge (exists today)
```

### 2. Sinks are generic; Edge Config is the first one

The fan-out step takes a list of typed sinks, not a hardcoded Vercel call.
Cloudflare KV, a customer's own endpoint, and future providers are the same
interface. This PRD implements exactly one sink type and the plumbing.

### 3. The credential lives on the crobot project record

It is customer-entered in the admin UI and belongs with the project, encrypted at
rest. Two new fields:

| Field | Notes |
| --- | --- |
| `vercel_edge_config_id` | e.g. `ecfg_abc123` |
| `vercel_api_token` | scoped token, encrypted at rest, write-only in the UI |

It rides along in the publish POST — server-to-server, already Bearer-authed —
and the collector treats it as a **transient parameter it never persists**. The
alternative (a `PUT /api/v1/config/{id}/sinks` on the collector) puts secrets in
two stores and creates rotation drift.

### 4. Our store stays the source of truth; sinks are downstream

Write `ConfigStore` first and return success on that alone. Sink writes are
fan-out with retry, never blocking the publish response. A sink that is down must
not fail a publish.

### 5. Staleness must be detectable, not silent

The written payload carries `config_hash`. The collector records the last
successfully-synced hash per sink and exposes it, so a revoked token surfaces as
"Edge Config is 3 publishes behind" in the dashboard instead of silently serving
last week's traffic split. **This is the load-bearing requirement of the PRD** —
see _Risks_.

### 6. Edge Config feeds the PROXY only, never a browser SDK

`ProjectConfig.geo` is spliced into the served JSON by the `testa-config-geo`
worker at the CDN edge, because a browser has no other way to learn its own
country. Edge Config cannot do that.

This is harmless for the proxy, which derives geo from the request
(`x-vercel-ip-country`, `middleware.ts:724`) and is already required to ignore
`config.geo`. It is **not** harmless for a browser SDK: with `config.geo` absent,
a `region_country` fact resolves unsupported, targeting treats that as
not-eligible, and the visitor silently fails to enroll. The client keeps reading
`configUrl` through the CDN. A guard belongs in the SDK for anyone who wires a
geo-less config into a client surface.

| Path | Config source | Geo source |
| --- | --- | --- |
| Proxy / middleware | Edge Config (new) or `configUrl` | request headers |
| Browser SDK / pixel | `configUrl` via CDN | `config.geo`, edge-spliced |

---

## Scope

**In:**

- A `sinks` concept in the collector's config route: fan out after the store
  write, with retry and per-sink last-synced-hash recording.
- A Vercel Edge Config sink (`PATCH /v1/edge-config/{id}/items`).
- crobot: two project fields, admin UI, pass-through on the publish POST.
- A documented `loadConfig` recipe for `createTestaProxy` + a note that Edge
  Config makes `decisions: 'server'` the right default on Vercel.
- Sync health surfaced per project.

**Out:**

- Any change to the read path, the engine, or the middleware.
- Other sink types (CF KV, customer webhooks) — interface only.
- Making `decisions: 'server'` the package default. Separate call, needs data.
- Tier 2 precompute / `generateStaticParams` variants — see PRD 007.

---

## Task breakdown

1. `SinkTarget` type + `fanOutToSinks(config, sinks, deps)` in the collector,
   with retry and structured result per sink.
2. Vercel Edge Config sink implementation + unit tests against a faked fetch.
3. Wire into `POST /api/v1/config/:projectId` after the store write; never block
   the response (`waitUntil`-style).
4. Last-synced-hash store + `GET /api/v1/config/:projectId/sinks` for health.
5. crobot: migration, encrypted field, admin UI, publish-payload pass-through.
6. Docs: `loadConfig` + Edge Config recipe in the Next.js integration guide.
7. SDK guard: warn when a client surface is handed a config with no `geo` while
   a `region_country` rule exists.

---

## Risks

- **Silently stale config is worse than no config.** A revoked token means the
  proxy keeps serving a valid-looking old config and the experiment quietly
  skews. Mitigated by decision 5; this is why health reporting is in scope
  rather than a follow-up.
- **We hold a customer's Vercel API token.** Scope requirements, encryption at
  rest, write-only in the UI, and never logged. A leak is a write credential to
  their infrastructure.
- **Edge Config size limits** (per-item and per-store) bound how large a
  `ProjectConfig` can get. Needs measuring against the largest real project
  before rollout; fall back to `configUrl` above the bound rather than truncating.
- **Vercel-only.** This buys nothing for self-hosted or CF-fronted customers,
  who keep the CDN path. Do not let it become the only fast path.
