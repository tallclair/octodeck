#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

. ../scripts/lib/parallel.sh

FORCE=false
if [ "$1" = "--force" ]; then
    FORCE=true
fi

# Ensure fallback placeholder exists for Go embed on fresh checkouts
if [ ! -f "frontend_dist/index.html" ]; then
    mkdir -p frontend_dist
    echo "<!-- placeholder -->" > frontend_dist/index.html
fi

# Without --force, only report lint issues introduced by uncommitted changes.
LINT_ARGS="--new"
if [ "$FORCE" = "true" ]; then
    LINT_ARGS=""
fi

# Build, lint and tests are independent and run in parallel; the Go build cache
# is safe for concurrent use.
echo "Running backend checks in parallel..."
par_start
par_run build go build -o /dev/null ./...
par_run lint go tool golangci-lint run $LINT_ARGS
par_run test go test ./...
if ! par_wait; then
    echo "Error: Backend checks failed:$PAR_FAILED"
    exit 1
fi

echo "Backend verification passed."
