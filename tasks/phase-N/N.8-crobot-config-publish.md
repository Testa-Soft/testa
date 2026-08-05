---
id: "N.8"
title: "crobot publish side — write {hash}.json + current.json (and/or Edge Config) on config save"
phase: "N"
status: pending
estimate_days: 1
blocked_by: ["N.3"]
files_to_create:
  - "(crobot repo) config publish handler on save"
  - "(crobot repo) CDN uploader (immutable {hash}.json + pointer current.json)"
  - "(crobot repo) Vercel Edge Config writer (O2 adapter)"
  - "(crobot repo) tests for publish + pointer flip"
references:
  - docs/prds/003-nextjs-redirect-middleware.md
  - packages/shared-types/src/project-config.ts
commits: []
completed_at: null
---

## Goal

Implement the **publish side** in crobot: on config save, write the immutable
`{config_hash}.json` and the mutable `current.json` pointer to the CDN (and/or
write to Vercel Edge Config), so `@testa/next`'s `ConfigClient` (N.3) picks up
changes on the next request with no redeploy. This is the counterpart to the N.3
read side.

## Context

**Config creation stays in crobot for the MVP** — the admin edits config in
crobot, and crobot is where the publish-on-save hook lives. This task is
cross-repo (lives in the `crobot` repo; tracked here for cross-repo coherence);
coordinate per `AGENTS.md`.

**CDN publish (PRD "Publish side"):** on config save, crobot publishes two objects:

- **Immutable config:** `…/projects/{slug}/{config_hash}.json` — the full
  `ProjectConfig`, immutable ⇒ cacheable forever (`Cache-Control: immutable`).
- **Mutable pointer:** `…/projects/{slug}/current.json` →
  `{ "config_hash": "…", "published_at": "…" }` — tiny, served with a very short
  TTL / purged on publish so it flips immediately.

This reuses the `config_hash` field that already exists on `ProjectConfig`.

**Edge Config (O2):** on Vercel, crobot writes config to Vercel Edge Config via
the Vercel API on publish (writes propagate in seconds). The CDN-hashed-JSON path
stays as the portable fallback for non-Vercel / self-hosted Next. Both feed the
same `ConfigClient` interface on the read side; which one crobot writes is the
deployment's choice (O2, decided before N.3's default adapter).

The read side (N.3) must exist first so publish is verified end-to-end against a
real consumer.

## Acceptance criteria

- On config save, crobot computes/uses `config_hash` and uploads the immutable
  `{config_hash}.json` (full `ProjectConfig`) with `Cache-Control: immutable`.
- crobot writes/updates `current.json` →
  `{ config_hash, published_at }` with a very short TTL and purges/invalidates the
  pointer on publish so it flips immediately.
- Publishing is idempotent for an unchanged config (same hash → immutable object
  already present, only the pointer's `published_at` refreshes).
- **Edge Config adapter (O2):** on a Vercel deployment, crobot writes the config
  to Edge Config via the Vercel API on save.
- End-to-end: after a save, `@testa/next`'s `ConfigClient` (N.3) returns the new
  config on the next request (verified against the N.3 read side).
- The published payload validates against the shared `ProjectConfig` schema.

## Implementation notes

- Reuse the existing `config_hash` on `ProjectConfig`; do not invent a new hashing
  scheme — the read side keys its immutable cache on it.
- Purge/short-TTL the pointer specifically; the immutable object must never be
  purged (it is content-addressed).
- Guard the publish so a partial failure (immutable uploaded, pointer not flipped)
  is retried / does not leave the pointer referencing a missing object — upload
  immutable first, flip pointer last.
- Follow `AGENTS.md` cross-repo coordination (this ships in the crobot repo).

## Tests

- Save → immutable object present at `{hash}.json` with `immutable` cache header.
- Save → pointer `current.json` flips to the new hash and is short-TTL/purged.
- Unchanged config → idempotent (pointer `published_at` refreshes, immutable
  reused).
- Edge Config write path (O2) updates the config value.
- Ordering: immutable uploaded before pointer flip; pointer never references a
  missing object.

## Out of scope

- The `@testa/next` read side / instance cache — see N.3.
- Config authoring UI changes in crobot (config creation already exists; this only
  adds the publish-on-save hook).
