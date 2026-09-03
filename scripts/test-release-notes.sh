#!/usr/bin/env bash
set -euo pipefail

# scripts/test-release-notes.sh
# Test suite for scripts/release-notes.sh

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-notes.sh"

if [ ! -f "$SCRIPT_PATH" ]; then
    echo "Error: release-notes.sh not found at '$SCRIPT_PATH'" >&2
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

assert_not_contains() {
    local label="$1"
    local output="$2"
    local needle="$3"
    if [[ "$output" != *"$needle"* ]]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "  [PASS] $label"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "  [FAIL] $label (expected NOT to contain '$needle')"
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

echo "=== Running Release Notes Generator Test Suite ==="

# Test Group 1: Argument validation & error handling in main repo
echo "--- Group 1: Argument Validation & Error Handling ---"
set +e
output=$("$SCRIPT_PATH" "nonexistent_ref" "HEAD" 2>&1)
code=$?
set -e
assert_exit_code "invalid previous ref exits 1" 1 "$code"
assert_contains "invalid previous ref prints error" "$output" "Error: Invalid previous reference 'nonexistent_ref'"

set +e
output=$("$SCRIPT_PATH" "v0.0.1" "nonexistent_ref" 2>&1)
code=$?
set -e
assert_exit_code "invalid target ref exits 1" 1 "$code"
assert_contains "invalid target ref prints error" "$output" "Error: Invalid target reference 'nonexistent_ref'"

set +e
output=$("$SCRIPT_PATH" "v0.0.1" "HEAD" "extra_arg" 2>&1)
code=$?
set -e
assert_exit_code "too many arguments exits 1" 1 "$code"
assert_contains "too many arguments prints usage" "$output" "Usage:"

# Test Group 2: Empty range handling
echo "--- Group 2: Empty Range Handling ---"
output=$("$SCRIPT_PATH" "HEAD" "HEAD")
assert_contains "empty range header" "$output" "## Release Notes (HEAD..HEAD)"
assert_contains "empty range message" "$output" "No changes found."

# Test Group 3: Isolated repo tests with tags, categorization, and omission
echo "--- Group 3: Categorization & Filtering in Isolated Repo ---"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

git -C "$TMP_DIR" init --quiet
git -C "$TMP_DIR" config user.name "OctoDeck Tester"
git -C "$TMP_DIR" config user.email "tester@octodeck.test"

# Initial commit
touch "$TMP_DIR/init"
git -C "$TMP_DIR" add init
git -C "$TMP_DIR" commit --quiet -m "chore: initial commit"
git -C "$TMP_DIR" tag v0.1.0

# Add commits between v0.1.0 and v0.2.0
touch "$TMP_DIR/f1" && git -C "$TMP_DIR" add f1 && git -C "$TMP_DIR" commit --quiet -m "feat: standard feature"
touch "$TMP_DIR/f2" && git -C "$TMP_DIR" add f2 && git -C "$TMP_DIR" commit --quiet -m "feat(api): scoped feature"
touch "$TMP_DIR/f3" && git -C "$TMP_DIR" add f3 && git -C "$TMP_DIR" commit --quiet -m "feat!: breaking feature without scope"
touch "$TMP_DIR/f4" && git -C "$TMP_DIR" add f4 && git -C "$TMP_DIR" commit --quiet -m "feat(sync/engine)!: breaking feature with scope"
touch "$TMP_DIR/x1" && git -C "$TMP_DIR" add x1 && git -C "$TMP_DIR" commit --quiet -m "fix: simple bug fix"
touch "$TMP_DIR/x2" && git -C "$TMP_DIR" add x2 && git -C "$TMP_DIR" commit --quiet -m "fix(backend): scoped bug fix"
touch "$TMP_DIR/x3" && git -C "$TMP_DIR" add x3 && git -C "$TMP_DIR" commit --quiet -m "fix!: breaking fix without scope"
touch "$TMP_DIR/x4" && git -C "$TMP_DIR" add x4 && git -C "$TMP_DIR" commit --quiet -m "fix(db/sqlite)!: breaking fix with scope"
touch "$TMP_DIR/o1" && git -C "$TMP_DIR" add o1 && git -C "$TMP_DIR" commit --quiet -m "docs: update documentation"
touch "$TMP_DIR/o2" && git -C "$TMP_DIR" add o2 && git -C "$TMP_DIR" commit --quiet -m "chore(ci): update build workflow"
touch "$TMP_DIR/o3" && git -C "$TMP_DIR" add o3 && git -C "$TMP_DIR" commit --quiet -m "Non-conventional commit description"

git -C "$TMP_DIR" tag v0.2.0

# Run in TMP_DIR with default args (should resolve v0.2.0..HEAD which is empty)
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH")
assert_contains "on tag default empty range" "$output" "No changes found."

# Run in TMP_DIR with v0.1.0 v0.2.0
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "v0.2.0")
assert_contains "range header" "$output" "## Release Notes (v0.1.0..v0.2.0)"
assert_contains "features header" "$output" "### Features"
assert_contains "fixes header" "$output" "### Fixes"
assert_contains "other changes header" "$output" "### Other Changes"

# Verify feature commits categorized under Features
assert_contains "feature standard" "$output" "- feat: standard feature"
assert_contains "feature scoped" "$output" "- feat(api): scoped feature"
assert_contains "feature breaking" "$output" "- feat!: breaking feature without scope"
assert_contains "feature scoped breaking" "$output" "- feat(sync/engine)!: breaking feature with scope"

# Verify fix commits categorized under Fixes
assert_contains "fix simple" "$output" "- fix: simple bug fix"
assert_contains "fix scoped" "$output" "- fix(backend): scoped bug fix"
assert_contains "fix breaking" "$output" "- fix!: breaking fix without scope"
assert_contains "fix scoped breaking" "$output" "- fix(db/sqlite)!: breaking fix with scope"

# Verify other commits categorized under Other Changes
assert_contains "docs commit" "$output" "- docs: update documentation"
assert_contains "chore commit" "$output" "- chore(ci): update build workflow"
assert_contains "non-conventional commit" "$output" "- Non-conventional commit description"

# Test Group 4: Section omission testing
echo "--- Group 4: Section Omission Testing ---"
# Create branch with only features
git -C "$TMP_DIR" checkout --quiet -b feat-only v0.1.0
touch "$TMP_DIR/fo1" && git -C "$TMP_DIR" add fo1 && git -C "$TMP_DIR" commit --quiet -m "feat: exclusive feature"
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "feat-only")
assert_contains "features section present" "$output" "### Features"
assert_not_contains "fixes section omitted" "$output" "### Fixes"
assert_not_contains "other section omitted" "$output" "### Other Changes"

# Create branch with only fixes
git -C "$TMP_DIR" checkout --quiet -b fix-only v0.1.0
touch "$TMP_DIR/fx1" && git -C "$TMP_DIR" add fx1 && git -C "$TMP_DIR" commit --quiet -m "fix: exclusive fix"
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "fix-only")
assert_not_contains "features section omitted" "$output" "### Features"
assert_contains "fixes section present" "$output" "### Fixes"
assert_not_contains "other section omitted" "$output" "### Other Changes"

# Test Group 5: Merge commit omission
echo "--- Group 5: Merge Commit Omission ---"
git -C "$TMP_DIR" checkout --quiet -b merge-branch v0.1.0
touch "$TMP_DIR/side" && git -C "$TMP_DIR" add side && git -C "$TMP_DIR" commit --quiet -m "feat: side branch feature"
git -C "$TMP_DIR" checkout --quiet fix-only
git -C "$TMP_DIR" merge --no-ff --quiet -m "Merge branch 'merge-branch' into fix-only" merge-branch
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "fix-only")
assert_not_contains "merge commit excluded" "$output" "Merge branch 'merge-branch'"
assert_contains "side feature retained" "$output" "- feat: side branch feature"
assert_contains "fix retained" "$output" "- fix: exclusive fix"

# Test Group 6: No tags repo (log from root)
echo "--- Group 6: No Tags in Repository ---"
TMP_NOTAGS=$(mktemp -d)
git -C "$TMP_NOTAGS" init --quiet
git -C "$TMP_NOTAGS" config user.name "OctoDeck Tester"
git -C "$TMP_NOTAGS" config user.email "tester@octodeck.test"
touch "$TMP_NOTAGS/c1" && git -C "$TMP_NOTAGS" add c1 && git -C "$TMP_NOTAGS" commit --quiet -m "feat: root feature"
touch "$TMP_NOTAGS/c2" && git -C "$TMP_NOTAGS" add c2 && git -C "$TMP_NOTAGS" commit --quiet -m "fix: root fix"
output=$(cd "$TMP_NOTAGS" && "$SCRIPT_PATH")
assert_contains "root header" "$output" "## Release Notes (HEAD)"
assert_contains "root feature" "$output" "- feat: root feature"
assert_contains "root fix" "$output" "- fix: root fix"
rm -rf "$TMP_NOTAGS"

echo "=========================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed."
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
