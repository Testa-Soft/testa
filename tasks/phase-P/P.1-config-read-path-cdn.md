---
id: "P.1"
title: "Prod config read path — static serving + Cloudflare CDN (R2 optional)"
phase: "P"
status: pending
estimate_days: 1
blocked_by: []
files_to_create:
  - apps/collector/src/config/r2-store.ts
references:
  - apps/collector/src/config/store.ts
  - decision_config_api_single_source (memory)
  - decision_prod_hardening (memory)
commits: []
completed_at: null
---

## Goal

Serve config **reads** in prod off a CDN, not through the collector process, so
the middleware's `configUrl` hits the edge and reads never touch the write API.

## Context

Today `fileConfigStore` writes `{CONFIG_DIR}/{projectId}.json` and the collector's
`GET /api/v1/config/:projectId` serves it. In prod, reads should be CDN-cached.
Two viable paths (pick per infra — see decision_prod_hardening):

1. **nginx static + Cloudflare (simplest, no new store).** The collector keeps
   writing files; nginx serves `CONFIG_DIR` statically at `/config/{id}.json`;
   Cloudflare (orange-cloud) caches at the edge. No code change beyond the deploy
   (see P.2). Middleware `host` points at the CDN subdomain.
2. **Cloudflare R2 `ConfigStore`.** Implement `r2Store(bucket)` behind the
   existing `ConfigStore` interface (`put`/`get` → R2 via S3 API or the CF
   binding). Collector writes to R2; the CDN serves the R2 bucket. ~30 lines.

`config_hash` is already the cache-buster; keep TTLs short + purge-on-write or a
hashed pointer (see PRD 003 config-distribution section).

## Acceptance criteria

- [ ] A read path where the middleware fetches config from a CDN URL (not the
      collector process), verified end-to-end.
- [ ] Config changes propagate within the agreed TTL (immediate on next request).
- [ ] If R2: `r2Store` passes the same store contract tests as `fileConfigStore`
      (put → get round-trip, absent → null, unsafe id rejected).
- [ ] Decision (nginx-static vs R2) recorded; the other path documented as the
      upgrade.
