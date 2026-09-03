#!/usr/bin/env bash
set -euo pipefail

# release.sh
# OctoDeck automated release script
# Usage: ./release.sh [OPTIONS] <version>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONFIRM_YES=false
DRY_RUN=false
SKIP_VERIFY=false
SKIP_PUSH=false
VERSION_ARG=""

# Environment variable overrides
if [ "${OCTODECK_CONFIRM_YES:-0}" = "1" ]; then
    CONFIRM_YES=true
fi
if [ "${OCTODECK_SKIP_VERIFY:-0}" = "1" ]; then
    SKIP_VERIFY=true
fi
if [ "${OCTODECK_SKIP_PUSH:-0}" = "1" ]; then
    SKIP_PUSH=true
fi

# Parse CLI options and arguments
while [ "$#" -gt 0 ]; do
    case "$1" in
        -y|--yes)
            CONFIRM_YES=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --skip-verify)
            SKIP_VERIFY=true
            shift
            ;;
        --skip-push)
            SKIP_PUSH=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS] <version>"
            echo ""
            echo "Automates the release process for OctoDeck."
            echo ""
            echo "Arguments:"
            echo "  <version>        SemVer release version (e.g. 'v0.1.0' or '0.1.0')"
            echo ""
            echo "Options:"
            echo "  -y, --yes        Automatically confirm release prompt"
            echo "  --dry-run        Perform checks and preview without creating/pushing tag"
            echo "  --skip-verify    Skip ./verify.sh gate"
            echo "  --skip-push      Skip pushing tag to remote"
            echo "  -h, --help       Show this help message"
            exit 0
            ;;
        -*)
            echo "Error: Unknown option '$1'" >&2
            echo "Usage: $0 [OPTIONS] <version>" >&2
            exit 1
            ;;
        *)
            if [ -n "$VERSION_ARG" ]; then
                echo "Error: Multiple version arguments provided ('$VERSION_ARG', '$1')" >&2
                echo "Usage: $0 [OPTIONS] <version>" >&2
                exit 1
            fi
            VERSION_ARG="$1"
            shift
            ;;
    esac
done

# 1. Argument Validation
if [ -z "$VERSION_ARG" ]; then
    echo "Error: Missing version argument." >&2
    echo "Usage: $0 [OPTIONS] <version>" >&2
    exit 1
fi

SEMVER_REGEX='^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ ! "$VERSION_ARG" =~ $SEMVER_REGEX ]]; then
    echo "Error: Invalid version format '$VERSION_ARG'." >&2
    echo "Expected format: vX.Y.Z or X.Y.Z (e.g. v0.1.0, 1.0.0)" >&2
    echo "Note: Leading zeroes and non-numeric components are not permitted." >&2
    exit 1
fi

TARGET_MAJOR="${BASH_REMATCH[1]}"
TARGET_MINOR="${BASH_REMATCH[2]}"
TARGET_PATCH="${BASH_REMATCH[3]}"
TARGET_TAG="v${TARGET_MAJOR}.${TARGET_MINOR}.${TARGET_PATCH}"

# 2. Git Preflight Checks
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: Not a git repository." >&2
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Error: Release must be executed on branch 'main'." >&2
    echo "Current branch is '${CURRENT_BRANCH:-unknown}'." >&2
    exit 1
fi

DIRTY_STATUS=$(git status --porcelain 2>/dev/null || true)
if [ -n "$DIRTY_STATUS" ]; then
    if [ "$DRY_RUN" = true ] || [ "${OCTODECK_ALLOW_DIRTY:-0}" = "1" ]; then
        echo "Warning: Working directory has uncommitted or untracked changes (proceeding due to dry-run/allow-dirty):" >&2
        git status --short >&2
    else
        echo "Error: Working directory has uncommitted or untracked changes." >&2
        git status --short >&2
        exit 1
    fi
fi

if git rev-parse -q --verify "refs/tags/$TARGET_TAG" >/dev/null 2>&1; then
    echo "Error: Tag '$TARGET_TAG' already exists locally." >&2
    exit 1
fi

if git remote 2>/dev/null | grep -q '^origin$'; then
    REMOTE_TAG_MATCH=$(git ls-remote --tags origin "refs/tags/$TARGET_TAG" 2>/dev/null || true)
    if [ -n "$REMOTE_TAG_MATCH" ]; then
        echo "Error: Tag '$TARGET_TAG' already exists on remote 'origin'." >&2
        exit 1
    fi
fi

# 3. Strict SemVer Incrementalism Enforcement
LATEST_TAG=$(git tag -l --sort=-v:refname 2>/dev/null | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | head -n 1 || true)
if [ -z "$LATEST_TAG" ]; then
    LATEST_TAG=$(git describe --tags --abbrev=0 --match "v[0-9]*.[0-9]*.[0-9]*" --exclude "*-*" 2>/dev/null || true)
    if [[ ! "$LATEST_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
        LATEST_TAG=""
    fi
fi

if [ -n "$LATEST_TAG" ]; then
    [[ "$LATEST_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
    LATEST_MAJOR="${BASH_REMATCH[1]}"
    LATEST_MINOR="${BASH_REMATCH[2]}"
    LATEST_PATCH="${BASH_REMATCH[3]}"

    EXP_PATCH="v${LATEST_MAJOR}.${LATEST_MINOR}.$((LATEST_PATCH + 1))"
    EXP_MINOR="v${LATEST_MAJOR}.$((LATEST_MINOR + 1)).0"
    EXP_MAJOR="v$((LATEST_MAJOR + 1)).0.0"

    if [ "$TARGET_TAG" != "$EXP_PATCH" ] && [ "$TARGET_TAG" != "$EXP_MINOR" ] && [ "$TARGET_TAG" != "$EXP_MAJOR" ]; then
        echo "Error: Target version '$TARGET_TAG' violates strict SemVer incrementalism from '$LATEST_TAG'." >&2
        echo "Next release must strictly be one of:" >&2
        echo "  Patch: $EXP_PATCH" >&2
        echo "  Minor: $EXP_MINOR" >&2
        echo "  Major: $EXP_MAJOR" >&2
        exit 1
    fi
else
    if [ "$TARGET_TAG" != "v0.0.1" ] && [ "$TARGET_TAG" != "v0.1.0" ] && [ "$TARGET_TAG" != "v1.0.0" ]; then
        echo "Error: Target version '$TARGET_TAG' is invalid for initial release in a tagless repository." >&2
        echo "Initial release must be one of: v0.0.1, v0.1.0, or v1.0.0" >&2
        exit 1
    fi
fi

# 4. Release Notes Preview
echo ""
echo "================================================================================"
echo "                           Release Notes Preview"
echo "================================================================================"
RELEASE_NOTES_CMD=""
if [ -x "$SCRIPT_DIR/scripts/release-notes.sh" ]; then
    RELEASE_NOTES_CMD="$SCRIPT_DIR/scripts/release-notes.sh"
elif [ -x "$SCRIPT_DIR/release-notes.sh" ]; then
    RELEASE_NOTES_CMD="$SCRIPT_DIR/release-notes.sh"
elif [ -x "./scripts/release-notes.sh" ]; then
    RELEASE_NOTES_CMD="./scripts/release-notes.sh"
fi

if [ -n "$RELEASE_NOTES_CMD" ]; then
    if [ -n "$LATEST_TAG" ]; then
        "$RELEASE_NOTES_CMD" "$LATEST_TAG" HEAD || true
    else
        "$RELEASE_NOTES_CMD" "" HEAD || true
    fi
else
    echo "Release notes generator not found; skipping preview."
fi
echo "================================================================================"
echo ""

# 5. User Confirmation
if [ "$CONFIRM_YES" = true ]; then
    echo "Proceeding with release (--yes specified)..."
else
    read -r -p "Proceed with release $TARGET_TAG? [y/N] " CONFIRM || CONFIRM="n"
    case "$CONFIRM" in
        [yY]|[yY][eE][sS])
            ;;
        *)
            echo "Release aborted by user." >&2
            exit 1
            ;;
    esac
fi

# 6. Verification Gate Execution
if [ "$SKIP_VERIFY" = true ]; then
    echo "Skipping verification gate (SKIP_VERIFY enabled)."
else
    echo "Running verification gate (./verify.sh --force)..."
    VERIFY_CMD=""
    if [ -x "$SCRIPT_DIR/verify.sh" ]; then
        VERIFY_CMD="$SCRIPT_DIR/verify.sh"
    elif [ -x "./verify.sh" ]; then
        VERIFY_CMD="./verify.sh"
    fi

    if [ -n "$VERIFY_CMD" ]; then
        if ! "$VERIFY_CMD" --force; then
            echo "Error: Verification gate failed. Aborting release." >&2
            exit 1
        fi
        echo "Verification gate passed."
    else
        echo "Error: verify.sh not found. Aborting release." >&2
        exit 1
    fi
fi

# 7. Dry-Run Check
if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "[DRY RUN] Preflights, preview, and verification completed successfully."
    echo "[DRY RUN] Would create tag: git tag -a \"$TARGET_TAG\" -m \"Release $TARGET_TAG\""
    echo "[DRY RUN] Would push tag:   git push origin \"$TARGET_TAG\""
    echo ""
    echo "Dry-run release passed for $TARGET_TAG."
    exit 0
fi

# 8. Tagging
echo "Creating annotated tag '$TARGET_TAG'..."
if ! git tag -a "$TARGET_TAG" -m "Release $TARGET_TAG"; then
    echo "Error: Failed to create tag '$TARGET_TAG'." >&2
    exit 1
fi
echo "Tag '$TARGET_TAG' created."

# 9. Push
if [ "$SKIP_PUSH" = true ]; then
    echo "Skipping git push (SKIP_PUSH enabled)."
else
    echo "Pushing tag '$TARGET_TAG' to origin..."
    if ! git push origin "$TARGET_TAG"; then
        echo "Error: Failed to push tag '$TARGET_TAG' to origin." >&2
        echo "The local tag '$TARGET_TAG' has been created. To push manually, run:" >&2
        echo "  git push origin '$TARGET_TAG'" >&2
        echo "To delete the local tag, run:" >&2
        echo "  git tag -d '$TARGET_TAG'" >&2
        exit 1
    fi
    echo "Tag '$TARGET_TAG' pushed to origin."
fi

# 10. Success Summary
COMMIT_HASH=$(git rev-parse --short HEAD)
echo ""
echo "================================================================================"
echo "Release $TARGET_TAG Successful!"
echo "================================================================================"
echo "  Tag:        $TARGET_TAG"
echo "  Commit:     $COMMIT_HASH"
if [ "$SKIP_PUSH" = true ]; then
    echo "  Remote:     Push skipped (tagged locally only)"
else
    echo "  Remote:     Pushed to origin/$TARGET_TAG"
fi
echo ""
echo "Next Steps:"
echo "  1. View GitHub release / tag:"
echo "     https://github.com/tallclair/octodeck/releases/tag/$TARGET_TAG"
echo "  2. Distribute binaries or deploy application artifacts."
echo "================================================================================"
