#!/usr/bin/env bash
# Provision (or update) the staging data stack on Fly: ClickHouse, Redis and
# the staging collector (api + consumer + modeler). Idempotent: existing apps,
# volumes and secrets are reused. Never touches the production testa-collector.
#
#   deploy/staging/provision.sh            # create what is missing, deploy all
#   deploy/staging/provision.sh collector  # redeploy the collector only
#
# Secrets come from $SECRETS_FILE (default ~/.config/testa-staging/secrets.env)
# and are passed to Fly on stdin, never as arguments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/deploy/staging"
REGION="${REGION:-fra}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.config/testa-staging/secrets.env}"

CH_APP=testa-staging-clickhouse
REDIS_APP=testa-staging-redis
COLLECTOR_APP=testa-collector-staging

log() { printf '[staging] %s\n' "$*"; }
die() { printf '[staging] ERROR: %s\n' "$*" >&2; exit 1; }

[ -r "$SECRETS_FILE" ] || die "secrets file $SECRETS_FILE not readable"
# shellcheck disable=SC1090
set -a; . "$SECRETS_FILE"; set +a
for k in SERVICE_TOKEN CONFIG_WRITE_TOKEN INGEST_SHARED_SECRET CROBOT_WEBHOOK_SECRET CLICKHOUSE_PASSWORD REDIS_PASSWORD; do
  [ -n "${!k:-}" ] || die "$k missing in $SECRETS_FILE"
done

ensure_app() {
  fly status --app "$1" >/dev/null 2>&1 && return 0
  log "creating app $1"
  fly apps create "$1"
}

ensure_volume() { # app name size_gb
  if fly volumes list --app "$1" --json | grep -q "\"name\": *\"$2\""; then return 0; fi
  log "creating volume $2 on $1"
  fly volumes create "$2" --app "$1" --region "$REGION" --size "$3" --yes
}

set_secrets() { # app, then KEY=VALUE lines on stdin; staged, applied by the next deploy
  fly secrets import --app "$1" --stage
}

deploy() { # config file
  (cd "$ROOT" && fly deploy --config "$1" --ha=false --yes)
}

clickhouse() {
  ensure_app "$CH_APP"
  ensure_volume "$CH_APP" ch_data 10
  printf 'CLICKHOUSE_PASSWORD=%s\n' "$CLICKHOUSE_PASSWORD" | set_secrets "$CH_APP"
  deploy "$DIR/clickhouse.fly.toml"
}

redis() {
  ensure_app "$REDIS_APP"
  ensure_volume "$REDIS_APP" redis_data 1
  printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD" | set_secrets "$REDIS_APP"
  deploy "$DIR/redis.fly.toml"
}

collector() {
  ensure_app "$COLLECTOR_APP"
  ensure_volume "$COLLECTOR_APP" staging_config 1
  {
    printf 'SERVICE_TOKEN=%s\n' "$SERVICE_TOKEN"
    printf 'CONFIG_WRITE_TOKEN=%s\n' "$CONFIG_WRITE_TOKEN"
    printf 'INGEST_SHARED_SECRET=%s\n' "$INGEST_SHARED_SECRET"
    printf 'CROBOT_WEBHOOK_SECRET=%s\n' "$CROBOT_WEBHOOK_SECRET"
    printf 'CLICKHOUSE_PASSWORD=%s\n' "$CLICKHOUSE_PASSWORD"
    printf 'REDIS_URL=redis://default:%s@%s.internal:6379?family=6\n' "$REDIS_PASSWORD" "$REDIS_APP"
  } | set_secrets "$COLLECTOR_APP"
  deploy "$DIR/collector.fly.toml"
}

verify() {
  local url="https://$COLLECTOR_APP.fly.dev"
  log "health: $(curl -fsS "$url/_internal/health" || echo 'FAILED')"
  local probe="$url/api/v1/experiments/0/daily-summary?project_id=0"
  log "sync API without token: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$probe") (expect 401)"
  log "sync API with token:    HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "X-Service-Token: $SERVICE_TOKEN" "$probe") (expect 4xx, not 401)"
}

case "${1:-all}" in
  all) clickhouse; redis; collector; verify ;;
  clickhouse) clickhouse ;;
  redis) redis ;;
  collector) collector; verify ;;
  verify) verify ;;
  *) die "unknown target $1 (all|clickhouse|redis|collector|verify)" ;;
esac
