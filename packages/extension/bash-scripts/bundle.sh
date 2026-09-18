#!/bin/bash
set -e

# Runs as `pnpm bundle` from packages/extension. The build-and-carry half of
# bash-scripts/release.sh with no git half: bump the patch version, build, and
# land the result in this monorepo's desktop app, leaving the tree dirty on
# purpose (commit and tag are the user's call, never this script's).
# Everything is resolved from this script's own location, never from the cwd,
# so it works wherever it is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_DIR/../.." && pwd)"
cd "$EXTENSION_DIR"

# Bump patch version
VERSION=$(node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));const v=p.version.split('.');console.log(v[0]+'.'+v[1]+'.'+(+v[2]+1))")
bash bash-scripts/update_version.sh "$VERSION"

# Sync lockfile after version bump
pnpm install --no-frozen-lockfile

# Build
pnpm build

# Hand the build to the desktop's own sync script — it stages the copy beside
# the target and verifies identity (cloud name, gecko id, port, log prefix)
# before an atomic swap, so a stale or half-written bundle can never land.
node "$REPO_ROOT/apps/desktop/scripts/extension/sync.mjs"

echo
echo "Bundled v${VERSION} into apps/desktop — no git ops; the tree is left dirty on purpose."
