#!/bin/sh
set -e

# Change to repository root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Ensure fallback placeholder exists for Go embed on fresh checkouts
if [ ! -f "backend/frontend_dist/index.html" ]; then
    mkdir -p backend/frontend_dist
    echo '<!-- placeholder -->' > backend/frontend_dist/index.html
fi

# Derive version dynamically from git, fallback to dev
VERSION="${OCTODECK_VERSION:-$(git describe --tags --match "v*" --always --dirty 2>/dev/null || echo "dev")}"
if [ -z "$VERSION" ]; then
    VERSION="dev"
fi

OUTPUT="octodeck"
if [ "$1" = "-o" ] && [ -n "$2" ]; then
    OUTPUT="$2"
    shift 2
elif [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
    OUTPUT="$1"
    shift 1
fi

exec go build -ldflags "-X github.com/tallclair/octodeck/backend/internal/server.Version=${VERSION}" -o "$OUTPUT" "$@" ./backend
