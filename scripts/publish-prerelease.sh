#!/usr/bin/env bash
#
# Publish the SDK packages to npm under a NON-DEFAULT dist-tag, so the release is
# installable on purpose (`npm i @testa-soft/next@dev`) without reaching anyone
# whose range resolves `latest`.
#
# Usage:  ./scripts/publish-prerelease.sh [tag]        # tag defaults to "dev"
#
# Same machinery as publish-dev.sh (build + test first, pnpm pack so `workspace:*`
# is rewritten, npm publish with browser sign-in for 2FA, skip already-published
# versions so a partial failure is safe to re-run) plus two guards that matter
# more for a prerelease than for a stable cut:
#
#   1. --tag is passed EXPLICITLY. publish-dev.sh relies on publishConfig.tag,
#      which means a package whose manifest says "latest" silently moves the
#      default pointer. Here the tag is on the command line and wins.
#   2. Every version must be an identical PRERELEASE (1.4.0-dev.0, not 1.4.0).
#      A stable version on a side tag is legal but almost always a mistake, and
#      mismatched versions are fatal: pnpm rewrites `workspace:*` to the exact
#      local version, so next@1.4.0-dev.0 hard-pins the other three at
#      1.4.0-dev.0 and any drift breaks every install.

set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-dev}"

if [[ "$TAG" == "latest" ]]; then
  echo "ERROR: 'latest' is the default tag — use ./scripts/publish-dev.sh for a" >&2
  echo "       stable release. This script exists to publish OFF the default." >&2
  exit 1
fi

# Dependency order: dom & experiment-core first, then their consumers.
DIRS=(
  "packages/dom"
  "packages/experiment-core"
  "packages/react"
  "packages/next"
)

name_of() { node -p "require('./$1/package.json').name"; }
version_of() { node -p "require('./$1/package.json').version"; }

# ─── Guard: identical prerelease versions across all four ────────────────────
EXPECTED=$(version_of "${DIRS[0]}")

if [[ "$EXPECTED" != *-* ]]; then
  echo "ERROR: $EXPECTED is not a prerelease version." >&2
  echo "       A stable version published to '$TAG' will not be installed by any" >&2
  echo "       range, and is almost certainly not what you meant. Bump to" >&2
  echo "       something like ${EXPECTED}-dev.0 first." >&2
  exit 1
fi

for dir in "${DIRS[@]}"; do
  version=$(version_of "$dir")
  if [[ "$version" != "$EXPECTED" ]]; then
    echo "ERROR: version mismatch — $(name_of "$dir") is $version, expected $EXPECTED." >&2
    echo "       All four packages must share one version: the published manifests" >&2
    echo "       hard-pin each other, so a mismatch breaks every install." >&2
    exit 1
  fi
done

echo "==> Publishing $EXPECTED to the '$TAG' tag"
echo "    Installable as: npm i @testa-soft/next@$TAG"
echo

echo "==> Building ${#DIRS[@]} packages"
FILTERS=()
for dir in "${DIRS[@]}"; do
  FILTERS+=("--filter" "$(name_of "$dir")")
done
pnpm "${FILTERS[@]}" build

echo "==> Testing ${#DIRS[@]} packages"
pnpm "${FILTERS[@]}" test

PACK_DIR=$(mktemp -d)
trap 'rm -rf "$PACK_DIR"' EXIT

echo "==> Publishing (browser sign-in will open for approval)"
for dir in "${DIRS[@]}"; do
  name=$(name_of "$dir")
  version=$(version_of "$dir")
  echo "--> $name@$version"

  # Skip if this exact version is already on the registry (safe re-runs).
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "    already published — skipping"
    continue
  fi

  # pnpm pack rewrites workspace:* deps to the real local versions.
  tarball=$(cd "$dir" && pnpm pack --pack-destination "$PACK_DIR" | tail -1)
  npm publish "$tarball" --access public --auth-type=web --tag "$TAG"
done

echo
echo "==> Done. Dist-tags now:"
for dir in "${DIRS[@]}"; do
  name=$(name_of "$dir")
  tags=$(npm view "$name" dist-tags --json 2>/dev/null | tr -d '\n ' || echo '?')
  echo "    $name -> $tags"
done
echo
echo "Anyone on 'latest' is unaffected. To install this build:"
echo "    npm i @testa-soft/next@$TAG"
