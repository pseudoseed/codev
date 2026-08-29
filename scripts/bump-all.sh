#!/bin/sh
# Set every workspace package to the same version, anchored on the root
# package.json's version field. The root is private (never published), but
# its version is the canonical "what version is this monorepo" — same pattern
# used by Vue (vuejs/core) and Babel (babel/babel).
#
# Usage:
#   scripts/bump-all.sh                 # default: patch bump from root version
#   scripts/bump-all.sh patch           # patch bump (same as no-arg)
#   scripts/bump-all.sh minor           # minor bump
#   scripts/bump-all.sh major           # major bump
#   scripts/bump-all.sh 3.1.0-rc.1      # explicit version (for RCs, etc.)
#
# This script only rewrites the version field of each package.json — it does
# NOT commit or tag (so no `--no-git-tag-version` passthrough is needed,
# unlike `pnpm version` which auto-commits by default). It also does NOT
# reformat the JSON: the version line is patched in place. Stage, commit, and
# tag yourself afterward.

set -e

INPUT="${1:-patch}"

CURRENT="$(PKG=. node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!p.version) { console.error("Root package.json has no version field"); process.exit(1); }
  console.log(p.version);
')"

case "$INPUT" in
  patch|minor|major)
    case "$CURRENT" in
      *-*)
        echo "Cannot semantic-bump from pre-release version '$CURRENT'. Pass an explicit version instead." >&2
        exit 1
        ;;
    esac
    VERSION="$(CURRENT="$CURRENT" INPUT="$INPUT" node -e '
      const [maj, min, patch] = process.env.CURRENT.split(".").map(Number);
      const out = process.env.INPUT === "major" ? [maj + 1, 0, 0]
                : process.env.INPUT === "minor" ? [maj, min + 1, 0]
                : [maj, min, patch + 1];
      console.log(out.join("."));
    ')"
    echo "Anchor (root) @$CURRENT → $INPUT bump → $VERSION"
    ;;
  *)
    VERSION="$INPUT"
    ;;
esac

bump_file() {
  PKG_FILE="$1" VERSION="$VERSION" node -e '
    const fs = require("fs");
    const p = process.env.PKG_FILE;
    const newVersion = process.env.VERSION;
    const content = fs.readFileSync(p, "utf8");
    // Match the FIRST top-level "version" field (2-space indent, root level).
    // Anything deeper (e.g. version strings inside dependencies) is left alone.
    const pattern = /^(  "version"\s*:\s*")[^"]*(")/m;
    if (!pattern.test(content)) {
      console.error("Failed to find top-level version field in " + p);
      process.exit(1);
    }
    const newContent = content.replace(pattern, `$1${newVersion}$2`);
    fs.writeFileSync(p, newContent);
    const pkg = JSON.parse(newContent);
    console.log("Bumped " + pkg.name + " → " + pkg.version);
  '
}

# Root first — always bumped (private, no marketplace constraints).
bump_file "package.json"

# Bump the version-aligned workspace packages.
# codev/core/sdk/types are npm-published; artifact-canvas is version-aligned for consistency
# but consumed by hosts via workspace:* (not independently published in v1, per spec-945).
# porch-driver and t3-client became npm-published in spec 146 phase 9: @cluesmith/codev now
# has runtime `workspace:*` dependencies on them, and pnpm rewrites those to the dependency's
# own version at publish time. Left off this list they stay behind, are never published at the
# released version, and `npm install -g @cluesmith/codev` fails with E404.
for pkg in packages/codev packages/core packages/sdk packages/types packages/artifact-canvas \
           packages/porch-driver packages/t3-client; do
  bump_file "$pkg/package.json"
done
