#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

# Run lint
echo "Running frontend lint..."
if ! npm run lint; then
    echo "Error: Frontend lint failed."
    exit 1
fi

# Run tests
echo "Running frontend tests..."
if ! npm test; then
    echo "Error: Frontend tests failed."
    exit 1
fi

# Run builds for both targets to verify compilation
echo "Verifying webapp build..."
if ! npm run build:webapp; then
    echo "Error: WebApp build failed."
    exit 1
fi

echo "Verifying extension build..."
if ! npm run build:extension; then
    echo "Error: Extension build failed."
    exit 1
fi

echo "Frontend verification passed."