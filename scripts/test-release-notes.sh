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
assert_contains "empty range header" "$output" "# Release Notes Input (HEAD..HEAD)"
assert_contains "empty range message" "$output" "No user-facing changes found"

# Test Group 3: Isolated repo tests with tags, categorization, and omission
echo "--- Group 3: Categorization & Filtering in Isolated Repo ---"
TMP_DIR=$(mktemp -d)
TMP_NOTAGS=$(mktemp -d)
trap 'rm -rf "$TMP_DIR" "$TMP_NOTAGS"' EXIT

git -C "$TMP_DIR" init --quiet
git -C "$TMP_DIR" config user.name "OctoDeck Tester"
git -C "$TMP_DIR" config user.email "tester@octodeck.test"

n=0
commit() {
    n=$((n + 1))
    touch "$TMP_DIR/file$n"
    git -C "$TMP_DIR" add "file$n"
    git -C "$TMP_DIR" commit --quiet "$@"
}

commit -m "chore: initial commit"
git -C "$TMP_DIR" tag v0.1.0

# Add commits between v0.1.0 and v0.2.0
commit -m "feat: standard feature"
commit -m "feat(api): scoped feature" -m "Explains what the scoped feature does." -m "Signed-off-by: OctoDeck Tester <tester@octodeck.test>"
commit -m "feat(dashboard): headline feature" -m "Release-Note: major"
commit -m "feat!: breaking feature without scope"
commit -m "feat(sync/engine)!: breaking feature with scope"
commit -m "feat(config): breaking change via footer" -m "BREAKING CHANGE: the old config key is ignored."
commit -m "fix: simple bug fix"
commit -m "fix(backend): scoped bug fix"
commit -m "fix!: breaking fix without scope"
commit -m "fix(db/sqlite)!: breaking fix with scope"
commit -m "fix(extension): fix for an unreleased feature" -m "Release-Note: none"
commit -m "refactor(api)!: breaking refactor"
commit -m "docs: update documentation"
commit -m "chore(ci): update build workflow"
commit -m "perf: speed up queries"
commit -m "Non-conventional commit description"
commit -m "feat: feature that gets reverted"
git -C "$TMP_DIR" revert --no-edit HEAD >/dev/null
git -C "$TMP_DIR" commit --quiet --amend -m "revert: feature that gets reverted" -m "This reverts commit $(git -C "$TMP_DIR" rev-parse HEAD~1)."
commit -m "feat: feature that gets re-landed"
git -C "$TMP_DIR" revert --no-edit HEAD >/dev/null
git -C "$TMP_DIR" revert --no-edit HEAD >/dev/null

git -C "$TMP_DIR" tag v0.2.0

# Run in TMP_DIR with default args (should resolve v0.2.0..HEAD which is empty)
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH")
assert_contains "on tag default empty range" "$output" "No user-facing changes found"

# Run in TMP_DIR with v0.1.0 v0.2.0
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "v0.2.0")
assert_contains "range header" "$output" "# Release Notes Input (v0.1.0..v0.2.0)"

section() {
    # Prints the body of the named "## " section of $output.
    printf '%s\n' "$output" | awk -v title="## $1" '$0 == title { on = 1; next } /^## / { on = 0 } on'
}
breaking=$(section "Breaking Changes")
major=$(section "Major Features")
enhancements=$(section "Other Enhancements")
fixes=$(section "Bug Fixes")
omitted=$(section "Omitted")
included_sections="$breaking$major$enhancements$fixes"

# Section order: breaking, major, other enhancements, bug fixes
headers=$(printf '%s\n' "$output" | grep '^## ' | tr '\n' '|')
assert_contains "section order" "$headers" "## Breaking Changes|## Major Features|## Other Enhancements|## Bug Fixes|## Omitted|"
assert_contains "counts line" "$output" "Commits: 21 | Included: 12 | Omitted: 9"

# Breaking changes, regardless of type
assert_contains "breaking feat without scope" "$breaking" "### breaking feature without scope"
assert_contains "breaking feat with scope" "$breaking" "### sync/engine: breaking feature with scope"
assert_contains "breaking via footer" "$breaking" "### config: breaking change via footer"
assert_contains "breaking footer body kept" "$breaking" "BREAKING CHANGE: the old config key is ignored."
assert_contains "breaking fix without scope" "$breaking" "### breaking fix without scope"
assert_contains "breaking fix with scope" "$breaking" "### db/sqlite: breaking fix with scope"
assert_contains "breaking refactor" "$breaking" "### api: breaking refactor"
assert_contains "breaking metadata" "$breaking" "Type: refactor | Scope: api"
assert_not_contains "breaking feat not in enhancements" "$enhancements" "breaking feature"
assert_not_contains "breaking fix not in fixes" "$fixes" "breaking fix"

# Major features
assert_contains "major feature" "$major" "### dashboard: headline feature"
assert_not_contains "major feature not in enhancements" "$enhancements" "headline feature"
assert_not_contains "release-note trailer stripped" "$included_sections" "Release-Note:"

# Other enhancements
assert_contains "feature standard" "$enhancements" "### standard feature"
assert_contains "feature scoped" "$enhancements" "### api: scoped feature"
assert_contains "feature body included" "$enhancements" "Explains what the scoped feature does."
assert_contains "feature metadata" "$enhancements" "Type: feat | Scope: api"
assert_not_contains "signed-off-by stripped" "$output" "Signed-off-by"

# Bug fixes
assert_contains "fix simple" "$fixes" "### simple bug fix"
assert_contains "fix scoped" "$fixes" "### backend: scoped bug fix"
assert_not_contains "release-note none not included" "$included_sections" "fix for an unreleased feature"
assert_contains "release-note none listed as omitted" "$omitted" "fix(extension): fix for an unreleased feature (Release-Note: none)"

# Non-user-facing commits are listed by subject only under Omitted
assert_contains "docs omitted" "$omitted" "docs: update documentation"
assert_contains "chore omitted" "$omitted" "chore(ci): update build workflow"
assert_contains "perf omitted" "$omitted" "perf: speed up queries"
assert_contains "non-conventional omitted" "$omitted" "Non-conventional commit description"
assert_not_contains "omitted not in included sections" "$included_sections" "speed up queries"
assert_not_contains "commit before range excluded" "$output" "initial commit"
assert_not_contains "no prose preamble" "$output" "Entries are oldest first"

# Reverts
assert_not_contains "reverted feature not included" "$included_sections" "feature that gets reverted"
assert_contains "reverted feature listed" "$omitted" "feat: feature that gets reverted (reverted)"
assert_contains "revert commit listed" "$omitted" "revert: feature that gets reverted (revert)"
assert_contains "re-landed feature kept" "$enhancements" "### feature that gets re-landed"
assert_not_contains "re-land reverts not included" "$included_sections" "Revert \""

# Test Group 4: Section omission testing
echo "--- Group 4: Section Omission Testing ---"
git -C "$TMP_DIR" checkout --quiet -b feat-only v0.1.0
commit -m "feat: exclusive feature"
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "feat-only")
assert_contains "enhancements section present" "$output" "## Other Enhancements"
assert_not_contains "breaking section omitted" "$output" "## Breaking Changes"
assert_not_contains "major section omitted" "$output" "## Major Features"
assert_not_contains "fixes section omitted" "$output" "## Bug Fixes"

git -C "$TMP_DIR" checkout --quiet -b fix-only v0.1.0
commit -m "fix: exclusive fix"
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "fix-only")
assert_not_contains "enhancements section omitted" "$output" "## Other Enhancements"
assert_contains "fixes section present" "$output" "## Bug Fixes"

git -C "$TMP_DIR" checkout --quiet -b chores-only v0.1.0
commit -m "chore: tidy up"
commit -m "docs: explain things"
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "chores-only")
assert_contains "no user-facing changes" "$output" "No user-facing changes found."
assert_contains "chores listed as omitted" "$output" "chore: tidy up"

# Test Group 5: Merge commit omission
echo "--- Group 5: Merge Commit Omission ---"
git -C "$TMP_DIR" checkout --quiet -b merge-branch v0.1.0
commit -m "feat: side branch feature"
git -C "$TMP_DIR" checkout --quiet fix-only
git -C "$TMP_DIR" merge --no-ff --quiet -m "Merge branch 'merge-branch' into fix-only" merge-branch
output=$(cd "$TMP_DIR" && "$SCRIPT_PATH" "v0.1.0" "fix-only")
assert_not_contains "merge commit excluded" "$output" "Merge branch 'merge-branch'"
assert_contains "side feature retained" "$output" "### side branch feature"
assert_contains "fix retained" "$output" "### exclusive fix"

# Test Group 6: No tags repo (log from root)
echo "--- Group 6: No Tags in Repository ---"
git -C "$TMP_NOTAGS" init --quiet
git -C "$TMP_NOTAGS" config user.name "OctoDeck Tester"
git -C "$TMP_NOTAGS" config user.email "tester@octodeck.test"
touch "$TMP_NOTAGS/c1" && git -C "$TMP_NOTAGS" add c1 && git -C "$TMP_NOTAGS" commit --quiet -m "feat: root feature"
touch "$TMP_NOTAGS/c2" && git -C "$TMP_NOTAGS" add c2 && git -C "$TMP_NOTAGS" commit --quiet -m "fix: root fix"
output=$(cd "$TMP_NOTAGS" && "$SCRIPT_PATH")
assert_contains "root header" "$output" "# Release Notes Input (HEAD)"
assert_contains "root feature" "$output" "### root feature"
assert_contains "root fix" "$output" "### root fix"

echo "=========================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed."
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
