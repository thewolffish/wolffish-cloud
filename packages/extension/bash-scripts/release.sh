#!/bin/bash
set -e

# Runs as `pnpm release` from packages/extension. Everything that leaves this
# package is resolved from the script's own location, never from the cwd, so
# the copy lands in the monorepo's desktop app wherever it is invoked from.
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

# Copy into this monorepo's desktop app (apps/desktop/src/defaults/workspace/
# extension — the folder the desktop installs to ~/.wfc/workspace/extension on
# every launch), stripping sourcemaps and dev artifacts. The desktop's own
# sync script does the same copy standalone, with an atomic swap and an
# identity check: `node apps/desktop/scripts/extension/sync.mjs`.
TARGET="$REPO_ROOT/apps/desktop/src/defaults/workspace/extension"
rm -rf "$TARGET"
mkdir -p "$TARGET"
rsync -a --exclude='*.map' --exclude='refresh.js' dist/ "$TARGET/"

# Commit, tag, and push — scoped to this package and the bundle it refreshed,
# so a release never sweeps up unrelated work elsewhere in the monorepo.
git add -A -- "$EXTENSION_DIR" "$TARGET"
git commit -m "release: v${VERSION}"
git tag "v${VERSION}"
git push && git push --tags

echo "Released v${VERSION}"
