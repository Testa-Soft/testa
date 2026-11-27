#!/usr/bin/env bash
# Publish the 4.0 pixel to the staging edge worker.
#
#   deploy/staging/publish-pixel.sh <project-uuid> [bundle|config|all]
#
# The worker serves GET /projects/<uuid>.js from two KV entries that nothing
# fills in automatically yet:
#   integration_bundle:4.0     loader + runtime built from apps/pixel
#   project_config:<uuid>      the config the staging collector serves
#
# Re-run with `config` after changing an experiment in crobot staging: the
# worker reads its own copy, not the collector.
set -euo pipefail

SLUG="${1:?usage: publish-pixel.sh <project-uuid> [bundle|config|all]}"
WHAT="${2:-all}"
COLLECTOR_URL="${COLLECTOR_URL:-https://testa-collector-staging.fly.dev}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

kv_put() { # binding key file
  (cd "$ROOT/apps/edge" && npx wrangler kv key put "$2" --path "$3" --binding "$1" --env staging --remote)
}

if [ "$WHAT" = "bundle" ] || [ "$WHAT" = "all" ]; then
  pnpm --dir "$ROOT" --filter @testa-platform/pixel build
  # The loader must run first: it installs window._testa before the runtime hydrates it.
  # Source-map comments point at files the worker does not serve.
  for f in loader runtime; do
    grep -v '^//# sourceMappingURL=' "$ROOT/apps/pixel/dist/$f.min.js"
    printf '\n'
  done > "$TMP/bundle.js"
  kv_put KV_INTEGRATION_BUNDLES "integration_bundle:4.0" "$TMP/bundle.js"
fi

if [ "$WHAT" = "config" ] || [ "$WHAT" = "all" ]; then
  curl -fsS "$COLLECTOR_URL/api/v1/config/$SLUG" -o "$TMP/config.json"
  kv_put KV_PROJECT_CONFIG "project_config:$SLUG" "$TMP/config.json"
fi

echo "published: https://testa-edge-staging.mbagdonas6.workers.dev/projects/$SLUG.js"
