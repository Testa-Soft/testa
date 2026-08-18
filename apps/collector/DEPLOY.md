# Deploying the collector (config API) to Fly.io

The collector serves the **config API** the `@testa-soft/*` SDKs read from and
crobot writes to:

- `POST /api/v1/config/{projectId}` — write a project's config (Bearer-authed).
- `GET  /api/v1/config/{projectId}` — read it (what the SDK/middleware fetches).

Configs are stored as static `{projectId}.json` files under `CONFIG_DIR`, which
is a Fly **volume** so they survive deploys/restarts.

> This instance can also run ingest/metrics if you set `CLICKHOUSE_URL` +
> `REDIS_URL`, but for "just upload + serve configs" you don't need them.

## One-time setup

```bash
fly apps create testa-collector
fly volumes create testa_config --size 1 --region fra        # match fly.toml primary_region
fly secrets set CONFIG_WRITE_TOKEN="$(openssl rand -hex 24)"  # give this to crobot
```

Keep the token — crobot sends it as `Authorization: Bearer <token>` when it
publishes a config (see `GenerateProjectScriptHandler`).

## Deploy

Run from the **repo root** (the Docker build context must be the repo root):

```bash
fly deploy --config apps/collector/fly.toml --dockerfile apps/collector/Dockerfile
```

## DNS + CDN (config.testa-soft.tech)

Point the SDK's config host at the app via Cloudflare:

1. **CNAME** `config.testa-soft.tech` → `testa-collector.fly.dev` (proxied / orange-cloud).
2. **TLS cert on Fly (REQUIRED — else Cloudflare→origin returns `525`).** Because the
   record is proxied, Cloudflare terminates TLS at the edge and re-negotiates TLS to
   the Fly origin using SNI `config.testa-soft.tech`. Fly only has a cert for
   `*.fly.dev`, so the handshake fails (`525`) until you add the hostname:

   ```bash
   fly certs add config.testa-soft.tech --app testa-collector
   fly certs check config.testa-soft.tech --app testa-collector   # shows the challenge
   ```

   Fly's HTTP-01 validation can't complete *through* the proxy (chicken-and-egg: no
   cert yet → 525 → challenge unreachable), so validate via **DNS-01**: add a
   **DNS-only (grey-cloud)** CNAME `_acme-challenge.config.testa-soft.tech` →
   `<...>.flydns.net` (target shown by `fly certs check`). Keep Cloudflare SSL/TLS
   mode at **Full (strict)** — Fly serves a real Let's Encrypt cert. Cert issues in
   ~1 min; then `curl https://config.testa-soft.tech/_internal/live` → `200`.
3. **Cache the reads** — add a cache rule for `GET /api/v1/config/*` (respect the
   response's ETag/`config_hash`). This serves config reads from Cloudflare's edge,
   so the Fly machine stays suspended (near-zero cost) and reads are fast. Writes
   (`POST`) bypass cache automatically (non-GET). **crobot purges the exact URL
   `{config host}/api/v1/config/{uuid}` on publish** (`GenerateProjectScriptHandler::warmCache`),
   so a new config propagates immediately; the origin's `max-age` is only a
   missed-purge safety net.

The SDKs default to `https://config.testa-soft.tech`; with the CNAME in place no
client config change is needed. (Override per-deploy with the `host` option or
`TESTA_CONFIG_HOST` if you want a staging host.)

## Verify

```bash
# health
curl https://config.testa-soft.tech/_internal/health

# write a config (as crobot would)
curl -X POST https://config.testa-soft.tech/api/v1/config/12345 \
  -H "Authorization: Bearer $CONFIG_WRITE_TOKEN" \
  -H 'content-type: application/json' \
  --data '{ ...crobot ProjectResource JSON... }'

# read it back (what the middleware/SDK does)
curl https://config.testa-soft.tech/api/v1/config/12345
```

## Cost notes

- `shared-cpu-1x` / 256MB with `auto_stop_machines = "suspend"` + `min_machines_running = 0`
  means you pay ~only while serving; with reads cached at Cloudflare the origin is
  hit rarely. Expect well under a few USD/month.
- If you later want multi-region reads without the CDN, move config storage from the
  Fly volume to R2/S3 (the `ConfigStore` abstraction is designed for that) so all
  regions share one bucket. Not needed for a single-region v1.
