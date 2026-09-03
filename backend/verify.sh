#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

FORCE=false
if [ "$1" = "--force" ]; then
    FORCE=true
fi

# Ensure fallback placeholder exists for Go embed on fresh checkouts
if [ ! -f "frontend_dist/index.html" ]; then
    mkdir -p frontend_dist
    echo "<!-- placeholder -->" > frontend_dist/index.html
fi

echo "Running backend build..."
if ! go build -o /dev/null ./...; then
    echo "Error: Backend build failed."
    exit 1
fi

echo "Running backend lint..."
if [ "$FORCE" = "true" ]; then
    if ! go tool golangci-lint run; then
        echo "Error: Backend lint failed."
        exit 1
    fi
else
    if ! go tool golangci-lint run --new; then
        echo "Error: Backend lint failed."
        exit 1
    fi
fi

echo "Running backend tests..."
if ! go test ./...; then
    echo "Error: Backend tests failed."
    exit 1
fi

echo "Backend verification passed."
