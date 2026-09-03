#!/usr/bin/env bash
set -euo pipefail

# scripts/release-notes.sh
# Generates categorized Markdown release notes from git commit history.
# Usage: ./scripts/release-notes.sh [FROM_REF] [TO_REF]

# 1. Parse Arguments
if [ "$#" -eq 0 ]; then
    # Default FROM_REF to latest git tag matching v* (or empty if no tags exist)
    FROM_REF=$(git describe --tags --match "v*" --abbrev=0 2>/dev/null || git tag -l "v*" --sort=-v:refname | head -n 1 || true)
    TO_REF="HEAD"
elif [ "$#" -eq 1 ]; then
    FROM_REF="$1"
    TO_REF="HEAD"
elif [ "$#" -eq 2 ]; then
    FROM_REF="$1"
    TO_REF="$2"
else
    echo "Usage: $0 [FROM_REF] [TO_REF]" >&2
    exit 1
fi

# 2. Validate Git References
if [ -n "$FROM_REF" ]; then
    if ! git rev-parse --verify --quiet "$FROM_REF^{commit}" >/dev/null 2>&1; then
        echo "Error: Invalid previous reference '$FROM_REF'" >&2
        exit 1
    fi
fi

if ! git rev-parse --verify --quiet "$TO_REF^{commit}" >/dev/null 2>&1; then
    echo "Error: Invalid target reference '$TO_REF'" >&2
    exit 1
fi

# 3. Determine Commit Range and Display Header
if [ -n "$FROM_REF" ]; then
    RANGE="${FROM_REF}..${TO_REF}"
    DISPLAY_RANGE="${FROM_REF}..${TO_REF}"
else
    RANGE="${TO_REF}"
    DISPLAY_RANGE="${TO_REF}"
fi

# 4. Parse and Categorize Commits
feat_re="^feat(\([^\)]+\))?!?:[[:space:]]"
fix_re="^fix(\([^\)]+\))?!?:[[:space:]]"

features=()
fixes=()
other=()

while IFS= read -r subject; do
    [ -z "$subject" ] && continue
    if [[ "$subject" =~ $feat_re ]]; then
        features+=("$subject")
    elif [[ "$subject" =~ $fix_re ]]; then
        fixes+=("$subject")
    else
        other+=("$subject")
    fi
done < <(git log "$RANGE" --no-merges --format="%s")

# 5. Output Formatted Markdown
echo "## Release Notes ($DISPLAY_RANGE)"
echo ""

total=$((${#features[@]} + ${#fixes[@]} + ${#other[@]}))

if [ "$total" -eq 0 ]; then
    echo "No changes found."
    exit 0
fi

printed_section=false

if [ ${#features[@]} -gt 0 ]; then
    echo "### Features"
    for s in "${features[@]}"; do
        printf -- '- %s\n' "$s"
    done
    printed_section=true
fi

if [ ${#fixes[@]} -gt 0 ]; then
    if [ "$printed_section" = true ]; then
        echo ""
    fi
    echo "### Fixes"
    for s in "${fixes[@]}"; do
        printf -- '- %s\n' "$s"
    done
    printed_section=true
fi

if [ ${#other[@]} -gt 0 ]; then
    if [ "$printed_section" = true ]; then
        echo ""
    fi
    echo "### Other Changes"
    for s in "${other[@]}"; do
        printf -- '- %s\n' "$s"
    done
fi
