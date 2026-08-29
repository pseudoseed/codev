#!/usr/bin/env bash
# Pack workspace packages into tarballs and install them globally for testing.
# Run from the monorepo root: pnpm -w run local-install

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Workaround pnpm's prefix redirection: when this script is invoked via
# `pnpm -w run local-install`, pnpm sets `npm_config_prefix` to the workspace
# root, which makes `npm install -g` install into <workspace>/lib/node_modules
# instead of the actual system-global location. The result: the script
# reports "Installed" but the system binary is unchanged. Unset the override
# so npm uses the user's real global prefix (e.g. /opt/homebrew). Also clear
# the matching pnpm var for completeness.
unset npm_config_prefix
unset PNPM_CONFIG_PREFIX

# Build first (#11) — packing whatever happens to be sitting in dist/ silently
# ships stale code: the tarball installs fine and the printed version doesn't
# change (it comes from package.json, not from dist freshness), so a correct
# install of a stale artifact looks identical to success. The build is
# incremental, so this costs nothing when dist is already current.
pnpm -w run build

# Pack — clear stale tarballs first so the install glob matches exactly one file.
# codev-types is packed+installed too: codev now imports it at runtime (the
# request-auth wire constants), so it must be a real installed dependency, not
# just resolved from the workspace at build time.
#
# Every runtime `@cluesmith/*` dependency of packages/codev must appear in all four
# lists below. `pnpm pack` rewrites `workspace:*` to the dependency's own version, so
# one left out is resolved from the npm registry instead — and t3-client and
# porch-driver (added in spec 146 phase 9) are not published there, so the install
# E404s before Tower is restarted. A test in
# spec-146-phase-9-thread-backend.test.ts reads that dependency set from the manifest
# and asserts this file covers it.
rm -f packages/types/*.tgz packages/core/*.tgz packages/sdk/*.tgz packages/t3-client/*.tgz packages/porch-driver/*.tgz packages/codev/*.tgz
pnpm --filter @cluesmith/codev-types pack --pack-destination packages/types
pnpm --filter @cluesmith/codev-core pack --pack-destination packages/core
pnpm --filter @cluesmith/codev-sdk pack --pack-destination packages/sdk
pnpm --filter @cluesmith/t3-client pack --pack-destination packages/t3-client
pnpm --filter @cluesmith/porch-driver pack --pack-destination packages/porch-driver
pnpm --filter @cluesmith/codev pack --pack-destination packages/codev

# Uninstall first — `npm install -g` over an existing same-name package
# is sometimes a silent no-op, leaving the previous version installed.
# The rm -rf is belt-and-suspenders: when the tarball version matches the
# previously-installed version, npm's same-version short-circuit can leave
# stale files on disk even after uninstall+install.
GLOBAL_ROOT="$(npm root -g)"
npm uninstall -g @cluesmith/codev @cluesmith/codev-core @cluesmith/codev-sdk @cluesmith/codev-types @cluesmith/t3-client @cluesmith/porch-driver 2>/dev/null || true
rm -rf "$GLOBAL_ROOT/@cluesmith/codev" "$GLOBAL_ROOT/@cluesmith/codev-core" "$GLOBAL_ROOT/@cluesmith/codev-sdk" "$GLOBAL_ROOT/@cluesmith/codev-types" "$GLOBAL_ROOT/@cluesmith/t3-client" "$GLOBAL_ROOT/@cluesmith/porch-driver"

npm install -g \
  "$REPO_ROOT/packages/types/cluesmith-codev-types-"*.tgz \
  "$REPO_ROOT/packages/core/cluesmith-codev-core-"*.tgz \
  "$REPO_ROOT/packages/sdk/cluesmith-codev-sdk-"*.tgz \
  "$REPO_ROOT/packages/t3-client/cluesmith-t3-client-"*.tgz \
  "$REPO_ROOT/packages/porch-driver/cluesmith-porch-driver-"*.tgz \
  "$REPO_ROOT/packages/codev/cluesmith-codev-"*.tgz

# pnpm pack strips the executable bit from shell scripts in the tarball,
# which causes "GitHub CLI unavailable" errors when overview.ts tries to
# spawn scripts/forge/github/*.sh. Restore +x after install.
find "$(npm root -g)/@cluesmith/codev/scripts/forge" -name '*.sh' -exec chmod +x {} +

echo "Installed: $(codev --version)"

# Restart Tower so it picks up the new code.
afx tower stop && afx tower start

echo "Tower restarted — new code is now live."
