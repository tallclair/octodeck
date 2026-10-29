#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

. ../scripts/lib/parallel.sh

# The webapp bundle normally goes to backend/frontend_dist, which the backend
# embeds. Bundle into a scratch directory instead, so verification can run in
# parallel with the backend checks without emptying that directory under them.
WEBAPP_OUT=$(mktemp -d)
trap 'rm -rf "$WEBAPP_OUT"' EXIT

# All steps are independent and run in parallel. Type checking is its own step
# (vitest and vite don't need its output); running 'tsc -b' once avoids
# concurrent builds racing on its incremental build info. ESLint rules here are
# per-file (no type-aware linting), so its cache is safe.
echo "Running frontend checks in parallel..."
par_start
par_run typecheck npm run typecheck
par_run lint npm run lint -- --cache --cache-strategy content --cache-location node_modules/.cache/eslint/
par_run test npx vitest run
par_run webapp npm run bundle:webapp -- --outDir "$WEBAPP_OUT"
par_run extension npm run bundle:extension
if ! par_wait; then
    echo "Error: Frontend checks failed:$PAR_FAILED"
    exit 1
fi

echo "Frontend verification passed."
