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

## Setup checklist

Platform data stack (Fly): **done** — `testa-staging-clickhouse`, `testa-staging-redis`,
`testa-collector-staging` are live; `provision.sh verify` and `smoke.ts` pass.

1. **crobot on Forge** (crobot repo, branch `staging`, full guide `docs/deploy/staging.md`):
   - [ ] Server: PHP 8.2, MySQL 8, Redis, Node 20. Site root `public/`, branch `staging`, Let's Encrypt.
   - [ ] Environment: paste `docs/deploy/staging.env.example`; fill `APP_KEY`, `APP_URL`/`TRACKING_URL`/`FRONTEND_URL`, `DB_*`,
         `STAGING_SEED_EMAIL`/`STAGING_SEED_PASSWORD` (≥ 12 chars), and from `~/.config/testa-staging/secrets.env`:
         `TESTA_COLLECTOR_TOKEN` = `CONFIG_WRITE_TOKEN`, `TESTA_METRICS_TOKEN` = `SERVICE_TOKEN`,
         `TESTA_ANALYTICS_WEBHOOK_SECRET` = `CROBOT_WEBHOOK_SECRET`. Keep `APP_ENV=staging`, `TESTA_ANALYTICS_MOCK=false`,
         `TESTA_COLLECTOR_API_URL=https://testa-collector-staging.fly.dev`.
   - [ ] Deploy script from the guide (includes `adminlte:install --only=assets`, migrate, caches, `queue:restart`).
   - [ ] Queue worker: connection `redis`, queue `default` (not Horizon: it has no `staging` supervisor).
   - [ ] Scheduler: `php artisan schedule:run` every minute.
   - [ ] First deploy, then `php artisan db:seed --class=StagingSeeder --force`.
2. **Point the collector's webhooks at crobot** (once the Forge URL exists): set `CROBOT_WEBHOOK_URL` in
   `collector.fly.toml` to the crobot `APP_URL`, then `deploy/staging/provision.sh collector`. Optional: without it
   crobot's 15-minute cron still syncs.
3. **Edge worker**: **done** (`testa-edge-staging`, see "Edge worker" below); the simulator still posts straight to the collector.

## Test run with simulated traffic

1. Log in to crobot staging, create (or use the seeded) **v2** A/B test on the staging project, add its goals, **activate** it.
   Activating pushes the config to the staging collector and subscribes the experiment.
2. Note the project **UUID** (Team → project, or the `projects/<uuid>.js` script name) and the experiment **identifier**.
3. Check the collector serves it: `curl https://testa-collector-staging.fly.dev/api/v1/config/<uuid>` lists the experiment
   with `"platform_version":"v2"`.
4. Feed traffic (≈ 5000 visitors per variation over 14 days ≈ 25k events per variation):
   ```sh
   set -a; . ~/.config/testa-staging/secrets.env; set +a
   bun scripts/staging/simulate-traffic.ts --project <uuid> --experiment <identifier> --dry-run   # preview counts
   bun scripts/staging/simulate-traffic.ts --project <uuid> --experiment <identifier>
   # options: --visitors 5000 --days 14 --lift 1=1.15,2=0.95 --seed 7
   ```
   Variations and the numeric project id come from the served config, so they always match crobot. Each run uses a new
   seed (new visitors) unless `--seed` is given; rerunning the same seed resends the same events.
5. Within ~5 min the modeler builds the daily rows (`MODELER_INTERVAL_SEC=300`); crobot picks them up on its 15-minute
   cron, via the webhook, or `php artisan analytics:sync <experiment id> --wait=6`. All Analytics V2 tabs then fill in.

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

**Configs live in Redis** (`CONFIG_STORE=redis` in `collector.fly.toml`, keys
`testa:config:{uuid}` and `testa:config:by-project-id:{id}` in
`testa-staging-redis`), so the app, the modeler and any replacement machine
share one set and a lost machine/volume no longer loses them. The
`staging_config` volume is only the source of a one-time migration: on startup
the app copies any `{uuid}.json` there that Redis lacks (logged as
`[config] file→redis migration: …`). If the volume is empty, re-publish each
project from crobot (activate / save the experiment) to repopulate. Check:
```sh
fly ssh console --app testa-staging-redis -C "redis-cli -a \$REDIS_PASSWORD --scan --pattern 'testa:config:*'"
```

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

**Live:** `https://testa-edge-staging.mbagdonas6.workers.dev` (pixel endpoint `/track`).
KV ids are committed in `wrangler.toml` `[env.staging]`; secrets set: `INGEST_SHARED_SECRET`,
`INGEST_ORIGIN_URL`, `VISITOR_ID_SALT` (random). `COOKIE_FALLBACK_DOMAIN` is unset: on `*.workers.dev`
the edge cookie is not first-party anyway and `/track` does not depend on it. Staging uses a SQLite-backed
Durable Object (`new_sqlite_classes`): the account rejects new KV-backed DO namespaces (CF code 10099),
so `[env.production]` will need the same change before its first deploy.
The staging site sends v2 events here via Vercel `NEXT_PUBLIC_TESTA_EVENTS_URL` (staging custom env only).

Needs `npx wrangler login` once (from `apps/edge`). Re-deploy only needs the last command.

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
