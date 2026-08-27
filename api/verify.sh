#!/bin/sh

# Ensure the script runs from its own directory
cd "$(dirname "$0")"

# Redirect output to stderr
exec 1>&2

echo "Running API checks..."
if ! npm run lint; then
    echo "Error: API lint failed."
    exit 1
fi

echo "API verification passed."