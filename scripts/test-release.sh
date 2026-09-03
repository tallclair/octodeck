#!/usr/bin/env bash
set -euo pipefail

# scripts/test-release.sh
# Comprehensive automated test harness for release.sh

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/release.sh"
RELEASE_NOTES_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes.sh"

if [ ! -f "$SCRIPT_PATH" ]; then
    echo "Error: release.sh not found at '$SCRIPT_PATH'" >&2
    exit 1
fi

if [ ! -f "$RELEASE_NOTES_PATH" ]; then
    echo "Error: release-notes.sh not found at '$RELEASE_NOTES_PATH'" >&2
    exit 1
fi

PASS_COUNT=0
FAIL_COUNT=0

assert_contains() {
    local label="$1"
    local output="$2"
    local needle="$3"
    if [[ "$output" == *"$needle"* ]]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "  [PASS] $label"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "  [FAIL] $label (expected to contain '$needle')"
        echo "--- Output was: ---"
        echo "$output"
        echo "-------------------"
    fi
}

assert_exit_code() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if [ "$expected" -eq "$actual" ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "  [PASS] $label (exit $actual)"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "  [FAIL] $label (expected exit $expected, got $actual)"
    fi
}

echo "=== Running Release Automation Test Suite ==="

# ==============================================================================
# Group 1: Argument Validation & SemVer Syntax
# ==============================================================================
echo "--- Group 1: Argument Validation & SemVer Syntax ---"

# Missing argument
set +e
output=$("$SCRIPT_PATH" 2>&1)
code=$?
set -e
assert_exit_code "missing argument exits 1" 1 "$code"
assert_contains "missing argument prints error" "$output" "Missing version argument"
assert_contains "missing argument prints usage" "$output" "Usage:"

# Multiple version arguments
set +e
output=$("$SCRIPT_PATH" "v0.0.2" "v0.0.3" 2>&1)
code=$?
set -e
assert_exit_code "multiple version arguments exits 1" 1 "$code"
assert_contains "multiple arguments error message" "$output" "Multiple version arguments provided"

# Non-numeric component
set +e
output=$("$SCRIPT_PATH" "v1.a.0" 2>&1)
code=$?
set -e
assert_exit_code "non-numeric semver exits 1" 1 "$code"
assert_contains "invalid format message" "$output" "Invalid version format 'v1.a.0'"

# Missing patch component
set +e
output=$("$SCRIPT_PATH" "v1.0" 2>&1)
code=$?
set -e
assert_exit_code "missing patch exits 1" 1 "$code"
assert_contains "missing patch message" "$output" "Invalid version format 'v1.0'"

# Missing patch without 'v'
set +e
output=$("$SCRIPT_PATH" "1.0" 2>&1)
code=$?
set -e
assert_exit_code "missing patch without v exits 1" 1 "$code"
assert_contains "missing patch without v message" "$output" "Invalid version format '1.0'"

# Missing minor and patch
set +e
output=$("$SCRIPT_PATH" "v1" 2>&1)
code=$?
set -e
assert_exit_code "missing minor and patch exits 1" 1 "$code"

# Extra numeric component (four segments)
set +e
output=$("$SCRIPT_PATH" "1.2.3.4" 2>&1)
code=$?
set -e
assert_exit_code "extra component exits 1" 1 "$code"
assert_contains "extra component message" "$output" "Invalid version format '1.2.3.4'"

# Leading zero on major
set +e
output=$("$SCRIPT_PATH" "v01.0.0" 2>&1)
code=$?
set -e
assert_exit_code "leading zero on major exits 1" 1 "$code"
assert_contains "leading zero rejected" "$output" "Invalid version format 'v01.0.0'"
assert_contains "leading zero note" "$output" "Leading zeroes and non-numeric components are not permitted"

# Leading zero on minor
set +e
output=$("$SCRIPT_PATH" "v1.02.0" 2>&1)
code=$?
set -e
assert_exit_code "leading zero on minor exits 1" 1 "$code"

# Leading zero on patch
set +e
output=$("$SCRIPT_PATH" "v1.0.03" 2>&1)
code=$?
set -e
assert_exit_code "leading zero on patch exits 1" 1 "$code"

# Pre-release suffix (hyphen)
set +e
output=$("$SCRIPT_PATH" "v1.0.0-beta" 2>&1)
code=$?
set -e
assert_exit_code "pre-release tag exits 1" 1 "$code"

# Pre-release suffix (alpha with dot)
set +e
output=$("$SCRIPT_PATH" "v1.0.0-alpha.1" 2>&1)
code=$?
set -e
assert_exit_code "pre-release alpha exits 1" 1 "$code"

# Build metadata (+build)
set +e
output=$("$SCRIPT_PATH" "v1.0.0+build" 2>&1)
code=$?
set -e
assert_exit_code "build metadata exits 1" 1 "$code"

# Unknown option
set +e
output=$("$SCRIPT_PATH" "--unknown-flag" "v1.0.0" 2>&1)
code=$?
set -e
assert_exit_code "unknown option exits 1" 1 "$code"
assert_contains "unknown option message" "$output" "Unknown option '--unknown-flag'"

# Help option
set +e
output=$("$SCRIPT_PATH" "--help" 2>&1)
code=$?
set -e
assert_exit_code "help option exits 0" 0 "$code"
assert_contains "help prints usage" "$output" "Usage:"
assert_contains "help prints options" "$output" "--dry-run"

# ==============================================================================
# Group 2: Git Preflight Checks
# ==============================================================================
echo "--- Group 2: Git Preflight Checks ---"

TMP_TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

SETUP_REPO() {
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init --quiet -b main
    git -C "$dir" config user.name "OctoDeck Tester"
    git -C "$dir" config user.email "tester@octodeck.test"

    cp "$SCRIPT_PATH" "$dir/release.sh"
    mkdir -p "$dir/scripts"
    cp "$RELEASE_NOTES_PATH" "$dir/scripts/release-notes.sh"

    cat << 'MOCK_EOF' > "$dir/verify.sh"
#!/usr/bin/env bash
if [ "${MOCK_VERIFY_FAIL:-0}" = "1" ]; then
    echo "Mock verify: FAILING" >&2
    exit 1
fi
echo "Mock verify: PASSING"
exit 0
MOCK_EOF
    chmod +x "$dir/verify.sh"

    echo "initial content" > "$dir/file.txt"
    git -C "$dir" add .
    git -C "$dir" commit --quiet -m "chore: initial commit"
    git -C "$dir" tag -a "v0.0.1" -m "Release v0.0.1"
}

SETUP_REPO "$TMP_TEST_DIR/repo"
REPO="$TMP_TEST_DIR/repo"

# Not inside git repository check
NON_GIT_DIR="$TMP_TEST_DIR/not_a_repo"
mkdir -p "$NON_GIT_DIR"
cp "$SCRIPT_PATH" "$NON_GIT_DIR/release.sh"
set +e
output=$(cd "$NON_GIT_DIR" && ./release.sh "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "non-git repo exits 1" 1 "$code"
assert_contains "non-git repo error message" "$output" "Not a git repository"

# Branch check: non-main branch
git -C "$REPO" checkout --quiet -b feat-branch
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify --skip-push "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "non-main branch exits 1" 1 "$code"
assert_contains "branch error message" "$output" "Release must be executed on branch 'main'"
git -C "$REPO" checkout --quiet main

# Branch check: detached HEAD
git -C "$REPO" checkout --quiet --detach HEAD
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify --skip-push "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "detached HEAD exits 1" 1 "$code"
assert_contains "detached HEAD branch message" "$output" "Release must be executed on branch 'main'"
git -C "$REPO" checkout --quiet main

# Dirty working tree (untracked file)
touch "$REPO/untracked.txt"
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify --skip-push "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "untracked file exits 1" 1 "$code"
assert_contains "dirty message" "$output" "Working directory has uncommitted or untracked changes"
assert_contains "untracked file listed in status" "$output" "untracked.txt"
rm "$REPO/untracked.txt"

# Dirty working tree (modified file)
echo "modifications" >> "$REPO/file.txt"
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify --skip-push "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "modified file exits 1" 1 "$code"
assert_contains "modified file dirty message" "$output" "Working directory has uncommitted or untracked changes"
git -C "$REPO" checkout --quiet -- file.txt

# Existing local tag
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify --skip-push "v0.0.1" 2>&1)
code=$?
set -e
assert_exit_code "existing tag exits 1" 1 "$code"
assert_contains "existing tag message" "$output" "Tag 'v0.0.1' already exists locally"

# ==============================================================================
# Group 3: Strict Incrementalism Enforcement
# ==============================================================================
echo "--- Group 3: Strict Incrementalism Enforcement ---"

# Add a commit ahead of v0.0.1
echo "feature work" >> "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit --quiet -m "feat: implement release script"

# Valid patch increment: v0.0.2
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "valid patch passes" 0 "$code"
assert_contains "valid patch dry run pass" "$output" "Dry-run release passed for v0.0.2"

# Valid minor increment: v0.1.0
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.1.0" 2>&1)
code=$?
set -e
assert_exit_code "valid minor passes" 0 "$code"
assert_contains "valid minor dry run pass" "$output" "Dry-run release passed for v0.1.0"

# Valid major increment: v1.0.0
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v1.0.0" 2>&1)
code=$?
set -e
assert_exit_code "valid major passes" 0 "$code"
assert_contains "valid major dry run pass" "$output" "Dry-run release passed for v1.0.0"

# Bare version normalization: 0.0.2 -> v0.0.2
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "bare version normalized and passes" 0 "$code"
assert_contains "bare version normalized tag" "$output" "Dry-run release passed for v0.0.2"

# Patch jump: v0.0.3 (should reject and show allowed options)
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.0.3" 2>&1)
code=$?
set -e
assert_exit_code "patch jump exits 1" 1 "$code"
assert_contains "patch jump error message" "$output" "violates strict SemVer incrementalism"
assert_contains "shows patch option" "$output" "Patch: v0.0.2"
assert_contains "shows minor option" "$output" "Minor: v0.1.0"
assert_contains "shows major option" "$output" "Major: v1.0.0"

# Minor jump: v0.2.0
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.2.0" 2>&1)
code=$?
set -e
assert_exit_code "minor jump exits 1" 1 "$code"
assert_contains "minor jump error message" "$output" "violates strict SemVer incrementalism"

# Major jump: v2.0.0
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v2.0.0" 2>&1)
code=$?
set -e
assert_exit_code "major jump exits 1" 1 "$code"
assert_contains "major jump error message" "$output" "violates strict SemVer incrementalism"

# Dirty minor: v0.1.1 (non-zero patch on minor bump)
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.1.1" 2>&1)
code=$?
set -e
assert_exit_code "dirty minor exits 1" 1 "$code"

# Dirty major: v1.1.0 (non-zero minor on major bump)
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v1.1.0" 2>&1)
code=$?
set -e
assert_exit_code "dirty major exits 1" 1 "$code"

# Version downgrade: v0.0.0
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.0.0" 2>&1)
code=$?
set -e
assert_exit_code "downgrade exits 1" 1 "$code"

# ==============================================================================
# Group 4: Tagless Repository Handling
# ==============================================================================
echo "--- Group 4: Tagless Repository Handling ---"

TMP_TAGLESS="$TMP_TEST_DIR/tagless"
mkdir -p "$TMP_TAGLESS"
git -C "$TMP_TAGLESS" init --quiet -b main
git -C "$TMP_TAGLESS" config user.name "OctoDeck Tester"
git -C "$TMP_TAGLESS" config user.email "tester@octodeck.test"
echo "root file" > "$TMP_TAGLESS/init.txt"
cp "$SCRIPT_PATH" "$TMP_TAGLESS/release.sh"
git -C "$TMP_TAGLESS" add .
git -C "$TMP_TAGLESS" commit --quiet -m "feat: root commit"

# Initial patch: v0.0.1
set +e
output=$(cd "$TMP_TAGLESS" && ./release.sh --dry-run -y --skip-verify "v0.0.1" 2>&1)
code=$?
set -e
assert_exit_code "initial v0.0.1 passes" 0 "$code"
assert_contains "initial v0.0.1 summary" "$output" "Dry-run release passed for v0.0.1"

# Initial minor: v0.1.0
set +e
output=$(cd "$TMP_TAGLESS" && ./release.sh --dry-run -y --skip-verify "v0.1.0" 2>&1)
code=$?
set -e
assert_exit_code "initial v0.1.0 passes" 0 "$code"
assert_contains "initial v0.1.0 summary" "$output" "Dry-run release passed for v0.1.0"

# Initial major: v1.0.0
set +e
output=$(cd "$TMP_TAGLESS" && ./release.sh --dry-run -y --skip-verify "v1.0.0" 2>&1)
code=$?
set -e
assert_exit_code "initial v1.0.0 passes" 0 "$code"
assert_contains "initial v1.0.0 summary" "$output" "Dry-run release passed for v1.0.0"

# Initial arbitrary jump: v0.0.2 rejected
set +e
output=$(cd "$TMP_TAGLESS" && ./release.sh --dry-run -y --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "initial arbitrary jump v0.0.2 rejected" 1 "$code"
assert_contains "tagless error message" "$output" "Initial release must be one of: v0.0.1, v0.1.0, or v1.0.0"

# Initial minor jump: v0.2.0 rejected
set +e
output=$(cd "$TMP_TAGLESS" && ./release.sh --dry-run -y --skip-verify "v0.2.0" 2>&1)
code=$?
set -e
assert_exit_code "initial minor jump v0.2.0 rejected" 1 "$code"

# ==============================================================================
# Group 5: Release Notes Preview & Confirmation Prompt
# ==============================================================================
echo "--- Group 5: Release Notes Preview & Confirmation Prompt ---"

# Preview output verification
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.0.2")
assert_contains "preview header" "$output" "Release Notes Preview"
assert_contains "preview commit entry" "$output" "- feat: implement release script"

# Confirmation prompt rejected: 'n'
set +e
output=$(cd "$REPO" && printf "n\n" | ./release.sh --dry-run --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "prompt declined with n exits 1" 1 "$code"
assert_contains "aborted message on n" "$output" "Release aborted by user."

# Confirmation prompt rejected: empty / Enter
set +e
output=$(cd "$REPO" && printf "\n" | ./release.sh --dry-run --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "prompt declined with empty exits 1" 1 "$code"
assert_contains "aborted message on empty" "$output" "Release aborted by user."

# Confirmation prompt accepted: 'y'
set +e
output=$(cd "$REPO" && printf "y\n" | ./release.sh --dry-run --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "prompt accepted with y exits 0" 0 "$code"
assert_contains "dry run pass on y" "$output" "Dry-run release passed for v0.0.2"

# Confirmation prompt accepted: 'YES' (case-insensitive)
set +e
output=$(cd "$REPO" && printf "YES\n" | ./release.sh --dry-run --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "prompt accepted with YES exits 0" 0 "$code"

# Non-interactive CLI flag: -y
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "non-interactive -y passes" 0 "$code"
assert_contains "non-interactive -y message" "$output" "Proceeding with release (--yes specified)..."

# Non-interactive environment variable: OCTODECK_CONFIRM_YES=1
set +e
output=$(cd "$REPO" && OCTODECK_CONFIRM_YES=1 ./release.sh --dry-run --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "OCTODECK_CONFIRM_YES passes" 0 "$code"
assert_contains "OCTODECK_CONFIRM_YES message" "$output" "Proceeding with release (--yes specified)..."

# ==============================================================================
# Group 6: Verification Gate Execution
# ==============================================================================
echo "--- Group 6: Verification Gate Execution ---"

# Verification failure aborts release with exit 1 and creates NO tag
set +e
output=$(cd "$REPO" && MOCK_VERIFY_FAIL=1 ./release.sh -y --skip-push "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "verification failure exits 1" 1 "$code"
assert_contains "verify error message" "$output" "Verification gate failed. Aborting release."

# Ensure tag was NOT created on verify failure
if [ -z "$(git -C "$REPO" tag -l "v0.0.2")" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] verify failure created no tag"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] verify failure created unexpected tag"
fi

# Verification pass proceeds
set +e
output=$(cd "$REPO" && MOCK_VERIFY_FAIL=0 ./release.sh --dry-run -y "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "verification pass proceeds" 0 "$code"
assert_contains "verify success message" "$output" "Verification gate passed."

# ==============================================================================
# Group 7: Tag Creation, Message Verification & Remote Push
# ==============================================================================
echo "--- Group 7: Tag Creation, Message Verification & Remote Push ---"

BARE_REMOTE="$TMP_TEST_DIR/origin.git"
git init --bare --quiet "$BARE_REMOTE"
git -C "$REPO" remote add origin "$BARE_REMOTE"
git -C "$REPO" push --quiet -u origin main

# Full release v0.0.2 with verification and push
set +e
output=$(cd "$REPO" && ./release.sh -y "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "full release exits 0" 0 "$code"
assert_contains "tag created message" "$output" "Tag 'v0.0.2' created."
assert_contains "tag pushed message" "$output" "Tag 'v0.0.2' pushed to origin."
assert_contains "summary header" "$output" "Release v0.0.2 Successful!"

# Verify annotated tag object type
if [ "$(git -C "$REPO" cat-file -t "v0.0.2")" = "tag" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] tag v0.0.2 is an annotated tag"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] tag v0.0.2 is not an annotated tag"
fi

# Verify tag annotation message
tag_msg=$(git -C "$REPO" tag -l --format='%(contents)' "v0.0.2" | head -n 1)
if [ "$tag_msg" = "Release v0.0.2" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] tag annotation message is 'Release v0.0.2'"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] tag annotation message mismatch: got '$tag_msg'"
fi

# Verify remote origin received tag
remote_commit=$(git -c safe.bareRepository=all -C "$BARE_REMOTE" rev-parse "refs/tags/v0.0.2^{commit}")
local_commit=$(git -C "$REPO" rev-parse "refs/tags/v0.0.2^{commit}")
if [ "$remote_commit" = "$local_commit" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] tag v0.0.2 present on remote origin with matching commit"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] remote commit mismatch on origin"
fi

# Existing remote tag rejected on rerun
echo "more changes" >> "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit --quiet -m "feat: additional feature"
# Delete local tag to isolate the remote check
git -C "$REPO" tag -d "v0.0.2" >/dev/null
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-verify "v0.0.2" 2>&1)
code=$?
set -e
assert_exit_code "existing remote tag rejected" 1 "$code"
assert_contains "remote tag error" "$output" "Tag 'v0.0.2' already exists on remote 'origin'"

# Skip push flag (--skip-push / OCTODECK_SKIP_PUSH=1)
git -C "$REPO" fetch --quiet origin --tags
set +e
output=$(cd "$REPO" && ./release.sh -y --skip-push "v0.0.3" 2>&1)
code=$?
set -e
assert_exit_code "skip push release exits 0" 0 "$code"
assert_contains "skip push message" "$output" "Skipping git push"

# Verify local tag created
if [ "$(git -C "$REPO" tag -l "v0.0.3")" = "v0.0.3" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] local tag v0.0.3 created with --skip-push"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] local tag v0.0.3 missing"
fi

# Verify remote did NOT receive tag
set +e
git -c safe.bareRepository=all -C "$BARE_REMOTE" rev-parse -q --verify "refs/tags/v0.0.3" >/dev/null 2>&1
remote_v3_exists=$?
set -e
if [ "$remote_v3_exists" -ne 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] remote origin did not receive v0.0.3 when push was skipped"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] remote origin has v0.0.3 unexpectedly"
fi

# Dry run reports actions without tag creation
set +e
output=$(cd "$REPO" && ./release.sh --dry-run -y "v0.0.4" 2>&1)
code=$?
set -e
assert_exit_code "dry-run exits 0" 0 "$code"
assert_contains "dry-run summary" "$output" "Preflights, preview, and verification completed successfully"
assert_contains "dry-run would create tag" "$output" "Would create tag: git tag -a \"v0.0.4\""

if [ -z "$(git -C "$REPO" tag -l "v0.0.4")" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] dry-run created no local tag"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] dry-run created unexpected local tag"
fi

set +e
git -c safe.bareRepository=all -C "$BARE_REMOTE" rev-parse -q --verify "refs/tags/v0.0.4" >/dev/null 2>&1
remote_v4_exists=$?
set -e
if [ "$remote_v4_exists" -ne 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  [PASS] dry-run created no remote tag"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "  [FAIL] dry-run created unexpected remote tag"
fi

echo "=========================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed."
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
