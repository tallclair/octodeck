#!/bin/sh

# Verifies the components touched by local changes (staged, unstaged, and
# untracked). With --force, verifies everything with the strictest settings;
# CI always runs with --force.

# Ensure the script runs from the repository root
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

FORCE=false
if [ "$1" = "--force" ]; then
    FORCE=true
fi

# Ensure fallback placeholder exists for Go embed on fresh checkouts
if [ ! -f "backend/frontend_dist/index.html" ]; then
    mkdir -p backend/frontend_dist
    echo "<!-- placeholder -->" > backend/frontend_dist/index.html
fi

# Paths of all changed files (staged, unstaged, and untracked), one per line.
# Renames ("old -> new") contribute both paths.
CHANGED_FILES=$(git status --porcelain | cut -c4- | sed 's/ -> /\n/')

# changed <regex>: succeeds if any changed path matches the extended regex.
changed() {
    echo "$CHANGED_FILES" | grep -q -E "$1"
}

# Root-level files that affect a component are listed alongside its directory:
#   - go.work / go.work.sum pin module versions for both Go modules (backend and
#     the api/ code generators).
#   - package.json / package-lock.json / .npmrc drive the npm workspaces
#     (frontend runtime deps and the api/ buf toolchain).
#   - verify.sh and the shared scripts/lib/ helpers change how every component
#     is verified.
GO_ROOT='^go\.work(\.sum)?$'
NPM_ROOT='^(package\.json|package-lock\.json|\.npmrc)$'
SELF='^verify\.sh$|^scripts/lib/'

# API changes don't directly trigger backend/frontend checks: api/verify.sh
# fails if the committed generated code (under backend/ and frontend/) is
# stale, so any effect on those components shows up as changes there.
COMPONENTS=""
SKIPPED=""
select_component() { # <name> <regex>
    if [ "$FORCE" = "true" ] || changed "$2"; then
        COMPONENTS="$COMPONENTS $1"
    else
        SKIPPED="$SKIPPED $1"
    fi
}
select_component api "^api/|$GO_ROOT|$NPM_ROOT|$SELF"
select_component backend "^backend/|$GO_ROOT|$SELF"
select_component frontend "^frontend/|$NPM_ROOT|$SELF"
select_component scripts "^scripts/|^\.githooks/|^release\.sh$|$SELF"

if [ -n "$SKIPPED" ]; then
    echo "Skipping (no changes):$SKIPPED"
fi
if [ -z "$COMPONENTS" ]; then
    echo "Nothing to verify."
    exit 0
fi

. ./scripts/lib/parallel.sh

BACKEND_ARGS=""
if [ "$FORCE" = "true" ]; then BACKEND_ARGS="--force"; fi

echo "Verifying in parallel:$COMPONENTS"
par_start
for c in $COMPONENTS; do
    if [ "$c" = "backend" ]; then
        par_run "$c" ./backend/verify.sh $BACKEND_ARGS
    else
        par_run "$c" "./$c/verify.sh"
    fi
done

if ! par_wait; then
    echo
    echo "Verification failed:$PAR_FAILED. Fix errors before committing."
    exit 1
fi
echo "Verification passed."
