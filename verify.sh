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
#   - verify.sh changes how every component is verified.
GO_ROOT='^go\.work(\.sum)?$'
NPM_ROOT='^(package\.json|package-lock\.json|\.npmrc)$'
SELF='^verify\.sh$'

# API changes don't directly trigger backend/frontend checks: api/verify.sh
# fails if the committed generated code (under backend/ and frontend/) is
# stale, so any effect on those components shows up as changes there.
RUN_API=false
if [ "$FORCE" = "true" ] || changed "^api/|$GO_ROOT|$NPM_ROOT|$SELF"; then
    RUN_API=true
fi

RUN_BACKEND=false
if [ "$FORCE" = "true" ] || changed "^backend/|$GO_ROOT|$SELF"; then
    RUN_BACKEND=true
fi

RUN_FRONTEND=false
if [ "$FORCE" = "true" ] || changed "^frontend/|$NPM_ROOT|$SELF"; then
    RUN_FRONTEND=true
fi

RUN_SCRIPTS=false
if [ "$FORCE" = "true" ] || changed "^scripts/|^\.githooks/|^release\.sh$|$SELF"; then
    RUN_SCRIPTS=true
fi

EXIT_CODE=0

if [ "$RUN_API" = "true" ]; then
    echo "API changes detected (or forced)."
    if ! ./api/verify.sh; then
        EXIT_CODE=1
    fi
else
    echo "No API changes detected."
fi

if [ "$RUN_BACKEND" = "true" ]; then
    echo "Backend changes detected (or forced)."
    # Pass --force argument if it was set
    ARGS=""
    if [ "$FORCE" = "true" ]; then ARGS="--force"; fi

    if ! ./backend/verify.sh $ARGS; then
        EXIT_CODE=1
    fi
else
    echo "No backend changes detected."
fi

if [ "$RUN_FRONTEND" = "true" ]; then
    echo "Frontend changes detected (or forced)."
    if ! ./frontend/verify.sh; then
        EXIT_CODE=1
    fi
else
    echo "No frontend changes detected."
fi

if [ "$RUN_SCRIPTS" = "true" ]; then
    echo "Script changes detected (or forced)."
    if ! ./scripts/verify.sh; then
        EXIT_CODE=1
    fi
else
    echo "No script changes detected."
fi

if [ $EXIT_CODE -ne 0 ]; then
    echo "Verification failed. Fix errors before committing."
fi

exit $EXIT_CODE
