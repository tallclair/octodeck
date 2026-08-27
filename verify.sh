#!/bin/sh

# Redirect output to stderr
exec 1>&2

FORCE=false
if [ "$1" = "--force" ]; then
    FORCE=true
fi

# Get all changed files (staged, unstaged, and untracked)
CHANGED_FILES=$(git status --porcelain)

# Check if specific directories have changes
API_CHANGED=$(echo "$CHANGED_FILES" | grep -E "api/|buf.gen.yaml")
BACKEND_CHANGED=$(echo "$CHANGED_FILES" | grep "backend/")
FRONTEND_CHANGED=$(echo "$CHANGED_FILES" | grep "frontend/")

EXIT_CODE=0

if [ "$FORCE" = "true" ] || [ -n "$API_CHANGED" ]; then
    echo "API changes detected (or forced)."
    if ! ./api/verify.sh; then
        EXIT_CODE=1
    fi
else
    echo "No API changes detected."
fi

if [ "$FORCE" = "true" ] || [ -n "$BACKEND_CHANGED" ]; then
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

if [ "$FORCE" = "true" ] || [ -n "$FRONTEND_CHANGED" ]; then
    echo "Frontend changes detected (or forced)."
    if ! ./frontend/verify.sh; then
        EXIT_CODE=1
    fi
else
    echo "No frontend changes detected."
fi

if [ $EXIT_CODE -ne 0 ]; then
    echo "Verification failed. Fix errors before committing."
fi

exit $EXIT_CODE
