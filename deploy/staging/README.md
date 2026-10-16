# Staging environment

A full copy of the analytics pipeline for testing PRD-006 / crobot Analytics V2
by hand. It shares nothing with production: the production `testa-collector`
(config API serving live clients) and `main` are never touched from here.

```
browser + pixel ──/track──▶ testa-edge-staging (Cloudflare, *.workers.dev)
                               │ HMAC (INGEST_SHARED_SECRET)
                               ▼
crobot staging (Forge) ◀──▶ testa-collector-staging (Fly, *.fly.dev)
  config push, sync,          app: config API, ingest, sync/stats/query API
  stats, webhooks             consumer: Redis stream → ClickHouse
                              modeler: daily rows, extras, webhooks
                               │ private network (.internal, IPv6)
                    ┌──────────┴──────────┐
        testa-staging-clickhouse   testa-staging-redis
        (24.10, db `testa`)        (7.4, AOF, password)
```

| Piece | Where | Config |
|---|---|---|
| ClickHouse | Fly `testa-staging-clickhouse`, private | `clickhouse.fly.toml` |
| Redis | Fly `testa-staging-redis`, private | `redis.fly.toml` |
| Collector (api, consumer, modeler) | Fly `testa-collector-staging`, `https://testa-collector-staging.fly.dev` | `collector.fly.toml`, `collector.Dockerfile` |
| Edge worker | Cloudflare `testa-edge-staging` | `apps/edge/wrangler.toml` `[env.staging]` |
| crobot | Forge (staging) | crobot `docs/deploy/staging.md` |

Branch: `staging` (= `main` + `feat/prd006`). Deploy only from it.

## Secrets

Generated once into `~/.config/testa-staging/secrets.env` (mode 600, never
committed). Names and where they go:

| Secret | Collector | Edge | crobot env |
|---|---|---|---|
| `SERVICE_TOKEN` | ✓ | | `TESTA_METRICS_TOKEN` |
| `CONFIG_WRITE_TOKEN` | ✓ | | `TESTA_COLLECTOR_TOKEN` |
| `INGEST_SHARED_SECRET` | ✓ | ✓ | |
| `CROBOT_WEBHOOK_SECRET` | ✓ | | `TESTA_ANALYTICS_WEBHOOK_SECRET` |
| `CLICKHOUSE_PASSWORD` | ✓ (and ClickHouse) | | |
| `REDIS_PASSWORD` | via `REDIS_URL` (and Redis) | | |

## Data stack (Fly)

```sh
deploy/staging/provision.sh            # create missing apps/volumes, set secrets, deploy all, verify
deploy/staging/provision.sh collector  # redeploy the collector after a code change
deploy/staging/provision.sh verify     # health + sync API auth probe
```

The collector's release command applies ClickHouse migrations before each
version starts (`bun run src/db/migrate.ts`, idempotent).

Useful:
```sh
fly logs --app testa-collector-staging                    # all three processes
fly ssh console --app testa-staging-clickhouse -C "clickhouse-client --user testa --password \$CLICKHOUSE_PASSWORD -d testa -q 'SELECT count() FROM events'"
```

When crobot staging has a URL, set it so the modeler sends webhooks
(otherwise crobot's cron sync still picks results up):
```sh
# collector.fly.toml [env] CROBOT_WEBHOOK_URL = "https://<crobot-staging-host>"
deploy/staging/provision.sh collector
```

## Edge worker (Cloudflare)

Needs `npx wrangler login` once (from `apps/edge`).

```sh
cd apps/edge
npx wrangler kv namespace create KV_PROJECT_CONFIG --env staging       # put the ids into
npx wrangler kv namespace create KV_INTEGRATION_BUNDLES --env staging  # wrangler.toml [env.staging]
. ~/.config/testa-staging/secrets.env
printf '%s' "$INGEST_SHARED_SECRET" | npx wrangler secret put INGEST_SHARED_SECRET --env staging
printf '%s' "https://testa-collector-staging.fly.dev" | npx wrangler secret put INGEST_ORIGIN_URL --env staging
npx wrangler deploy --env staging
```

## Cost and pausing

Roughly: ClickHouse shared-cpu-2x/4 GB, two shared-cpu-2x/1 GB and two
shared-cpu-1x machines, plus 12 GB of volumes. Between test rounds:
```sh
for a in testa-collector-staging testa-staging-redis testa-staging-clickhouse; do
  fly scale count 0 --app $a --yes   # data stays on the volumes
done
```
Bring back with `fly scale count 1 --app <app>` (collector: per process,
`fly scale count app=1 consumer=1 modeler=1`).

## Tear down

`fly apps destroy <app>` for the three apps deletes their volumes too.
