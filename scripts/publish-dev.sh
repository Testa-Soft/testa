#!/usr/bin/env bash
#
# Publish the SDK packages to npm, in dependency order, using npm's BROWSER
# sign-in for 2FA (no authenticator OTP needed): each publish runs
# `npm publish --auth-type=web`, which opens the browser to approve.
#
# Usage:  ./scripts/publish-dev.sh
#
# Why pack-then-publish: `npm publish` alone does NOT rewrite `workspace:*`
# dependencies, but `pnpm pack` does — so we pack with pnpm (correct manifest)
# and hand the tarball to npm (browser auth). Builds + tests run first; any
# failure aborts before anything is published. Already-published versions are
# skipped, so the script is safe to re-run after a partial failure.

set -euo pipefail
cd "$(dirname "$0")/.."

# Dependency order: dom & experiment-core first, then their consumers.
DIRS=(
  "packages/dom"
  "packages/experiment-core"
  "packages/react"
  "packages/next"
)

FILTERS=()
for dir in "${DIRS[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")
  FILTERS+=("--filter" "$name")
done

echo "==> Building ${#DIRS[@]} packages"
pnpm "${FILTERS[@]}" build

echo "==> Testing ${#DIRS[@]} packages"
pnpm "${FILTERS[@]}" test

PACK_DIR=$(mktemp -d)
trap 'rm -rf "$PACK_DIR"' EXIT

echo "==> Publishing (browser sign-in will open for approval)"
for dir in "${DIRS[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")
  echo "--> $name@$version"

  # Skip if this exact version is already on the registry (safe re-runs).
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "    already published — skipping"
    continue
  fi

  # pnpm pack rewrites workspace:* deps to the real local versions.
  tarball=$(cd "$dir" && pnpm pack --pack-destination "$PACK_DIR" | tail -1)
  npm publish "$tarball" --access public --auth-type=web
done

echo "==> Done. Published versions:"
for dir in "${DIRS[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")
  echo "    $name -> $(npm view "$name" version 2>/dev/null || echo '?')"
done
