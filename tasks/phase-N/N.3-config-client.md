---
id: "N.3"
title: "ConfigClient — CDN pointer+immutable fetch with in-instance hash cache"
phase: "N"
status: pending
estimate_days: 1
blocked_by: ["N.2"]
files_to_create:
  - packages/next/src/config/config-client.ts
  - packages/next/src/config/cdn-adapter.ts
  - packages/next/src/config/edge-config-adapter.ts
  - packages/next/src/config/instance-cache.ts
  - packages/next/src/config/__tests__/config-client.test.ts
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/shared-types/src/project-config.ts
commits: []
completed_at: null
---

## Goal

Build the `ConfigClient`: an adapter interface that fetches the project's
`ProjectConfig` and makes config changes propagate **immediately** to the running
Next app (visible on the next request, no redeploy). Ship the CDN
pointer+immutable adapter as the portable default, with an Edge Config adapter
behind O2, both hidden behind one `ConfigClient` interface chosen by adapter.

## Context

Config distribution is the interesting part of the PRD. The requirement: the
moment an admin edits config, the running Next app picks it up on initial load,
without a redeploy. **Config creation stays in crobot for the MVP** — this task is
the read side only; crobot's publish side is N.8.

**CDN hashed-JSON approach (portable default, PRD "Read side"):**

- crobot publishes two objects (N.8): an **immutable** config at
  `…/projects/{slug}/{config_hash}.json` (cacheable forever,
  `Cache-Control: immutable`) and a tiny **mutable pointer** at
  `…/projects/{slug}/current.json` → `{ "config_hash": "…", "published_at": "…" }`
  served with a very short TTL / purged on publish so it flips immediately. This
  reuses the `config_hash` already on `ProjectConfig`.
- Per request on the hot path: (1) read the pointer (short TTL / Next fetch-cache
  `revalidate: 0` so a change is visible next request); (2) if its `config_hash`
  matches the in-memory instance cache, use the cached immutable config with zero
  extra fetch; (3) on a new hash, fetch `{config_hash}.json` once, cache it
  immutably in-instance, and revalidate the pointer in the background
  (`waitUntil`) to keep p99 flat. Net: changes live on the **next request**, while
  steady state adds at most one tiny cacheable pointer read.

**Edge Config recommendation (O2):** on Vercel, prefer **Vercel Edge Config** over
a CDN fetch — reads are ~0 ms (globally replicated, no per-request network hop),
writes propagate in seconds. crobot writes config to Edge Config via the Vercel
API on publish. The CDN-hashed-JSON path stays as the portable fallback for
non-Vercel / self-hosted Next. Both hide behind the same `ConfigClient`
interface, chosen by adapter. O2 (Edge Config vs CDN as the primary Vercel
adapter) must be decided before this task ships its default adapter.

## Acceptance criteria

- `ConfigClient` interface: `get(projectSlug): Promise<ProjectConfig>` returning
  the current config, adapter-agnostic.
- **CDN adapter** implements the pointer→immutable flow: reads `current.json`
  (short TTL), compares `config_hash` to the in-instance cache, fetches
  `{config_hash}.json` only on a new hash, caches it immutably per instance.
- In-instance hash cache: a pointer read whose hash matches the cache performs
  **zero** extra fetches; a new hash triggers exactly one immutable fetch.
- Pointer revalidation runs in the background (`waitUntil`) so it does not add to
  request latency at steady state.
- Config changes are visible on the **next request** after publish (immediate
  propagation), verified with a fake CDN whose pointer flips.
- **Edge Config adapter** implements the same interface (reads from Edge Config);
  adapter is selectable per deployment.
- Malformed/unreachable pointer or config fails safely (serves last-good cached
  config where available; documented behaviour on cold cache).

## Implementation notes

- Keep the instance cache a simple module-level map keyed by
  `slug → { hash, config }`; it is per-runtime-instance, not shared — that is
  fine (each instance revalidates via its own pointer read).
- Validate fetched config against the `ProjectConfig` schema at the boundary
  before caching — never trust the CDN payload.
- The adapter choice is config/env-driven; default to CDN unless Edge Config is
  configured. Do not couple the middleware to a specific adapter.

## Tests

- Cache hit: pointer hash matches cache → no immutable fetch.
- Cache miss: new hash → exactly one immutable fetch, then cached.
- Propagation: pointer flips hash → next `get()` returns the new config.
- Background revalidation does not block the returned promise.
- Schema-invalid payload rejected; unreachable pointer serves last-good.

## Out of scope

- crobot's publish side (`{hash}.json` + `current.json` / Edge Config write) —
  see N.8.
- The redirect decision loop that consumes the config — see N.4.
- Final O2 decision rationale (tracked as an open question; this task ships both
  adapters behind the interface).
