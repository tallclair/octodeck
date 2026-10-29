#!/bin/sh

# Runs the test suites for the repository scripts and git hooks.

# Ensure the script runs from the repository root
cd "$(dirname "$0")/.."

# Redirect output to stderr
exec 1>&2

EXIT_CODE=0
for t in scripts/test-*.sh; do
    echo "Running $t..."
    if ! "$t"; then
        echo "Error: $t failed."
        EXIT_CODE=1
    fi
done

if [ $EXIT_CODE -eq 0 ]; then
    echo "Script verification passed."
fi
exit $EXIT_CODE
