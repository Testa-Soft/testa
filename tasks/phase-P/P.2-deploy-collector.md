---
id: "P.2"
title: "Deploy the collector (Laravel Forge daemon + nginx + Cloudflare)"
phase: "P"
status: pending
estimate_days: 1
blocked_by: ["P.1"]
files_to_create:
  - docs/ops/collector-deploy.md
references:
  - apps/collector/Dockerfile
  - docker-compose.yml
  - decision_prod_hardening (memory)
commits: []
completed_at: null
---

## Goal

Run the collector (config API + event ingest) in prod as a managed, always-on
service reachable by crobot and the middleware, with the config read path on a CDN.

## Context — deployment decision (locked)

At the expected scale (~30–40M events/month) the collector is NOT throughput- or
latency-bound: the **Cloudflare edge worker fronts client ingest and batches**
before the collector sees it (server-to-server, <1 req/s), and the write
bottleneck is Redis/ClickHouse, not the HTTP layer. So global-edge/autoscale
(Fly.io) is redundant here — **use a single Hetzner box (co-located with crobot),
scale vertically first.** Fly only becomes worth it if we drop the CF worker and
take direct global browser writes, or want zero-ops multi-region.

**Laravel Forge fits well** (esp. co-located with crobot → crobot→collector is
`localhost`, no cross-host hop). It's Bun + a pnpm monorepo, so run it as a Forge
**Daemon** (Supervisor) executing Bun — NOT the built-in Node site type. The box
only needs the collector's real runtime deps (shared-types is type-only/erased):
`hono`, `ioredis`, `zod`, `@clickhouse/client`.

## Acceptance criteria

- [ ] Collector runs as a Forge Daemon: `bun run src/index.ts`, env `PORT`,
      `CONFIG_WRITE_TOKEN`, `REDIS_URL`, `CLICKHOUSE_URL`, `CONFIG_DIR`, restarts on crash.
- [ ] Forge site + nginx: reverse-proxy `/api/*` → `localhost:8090` (writes);
      serve `CONFIG_DIR` statically at `/config/*` (reads); Let's Encrypt SSL.
- [ ] Cloudflare proxies the config subdomain (edge caching).
- [ ] crobot env set (`TESTA_COLLECTOR_API_URL`, `TESTA_COLLECTOR_TOKEN`); config
      publish verified over the wire.
- [ ] `docs/ops/collector-deploy.md` runbook (daemon cmd, nginx location blocks,
      env, rollback).
- [ ] Consumer process (`dev:consumer` → prod) also runs as a daemon (event pipeline).
