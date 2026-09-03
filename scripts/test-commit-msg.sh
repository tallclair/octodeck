#!/usr/bin/env bash
set -e

# scripts/test-commit-msg.sh
# Test suite for .githooks/commit-msg

HOOK_PATH="${1:-.githooks/commit-msg}"

if [ ! -f "$HOOK_PATH" ]; then
    echo "Error: Hook not found at '$HOOK_PATH'" >&2
    exit 1
fi

PASS_COUNT=0
FAIL_COUNT=0

run_test() {
    local name="$1"
    local content="$2"
    local expected_exit="$3"

    local msg_file
    msg_file=$(mktemp)
    printf "%s\n" "$content" > "$msg_file"

    set +e
    "$HOOK_PATH" "$msg_file" > /dev/null 2>&1
    local actual_exit=$?
    set -e

    rm -f "$msg_file"

    if [ "$actual_exit" -eq "$expected_exit" ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "  [PASS] $name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "  [FAIL] $name (expected exit $expected_exit, got $actual_exit)"
    fi
}

run_arg_test() {
    local name="$1"
    local arg="$2"
    local expected_exit="$3"

    set +e
    if [ -z "$arg" ]; then
        "$HOOK_PATH" > /dev/null 2>&1
    else
        "$HOOK_PATH" "$arg" > /dev/null 2>&1
    fi
    local actual_exit=$?
    set -e

    if [ "$actual_exit" -eq "$expected_exit" ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "  [PASS] $name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "  [FAIL] $name (expected exit $expected_exit, got $actual_exit)"
    fi
}

echo "=== Running Commit-Msg Hook Test Suite ==="

# 1. Argument & File Validation
echo "--- Group 1: Argument & File Validation ---"
run_arg_test "missing argument" "" 1
run_arg_test "nonexistent file" "/tmp/nonexistent_file_octodeck_12345" 1

# 2. Valid Conventional Commit Subjects (Exit 0)
echo "--- Group 2: Valid Subjects & Formats ---"
run_test "feat without scope" "feat: add versioning" 0
run_test "fix with simple scope" "fix(backend): resolve node id error" 0
run_test "feat! breaking without scope" "feat!: breaking change" 0
run_test "feat! breaking with scope" "feat(api)!: breaking change" 0
run_test "scope with slash" "chore(ci/deploy): run builds" 0
run_test "scope with dot" "refactor(api/v1.0): clean types" 0
run_test "scope with hyphen and underscore" "style(ui_theme-dark): adjust padding" 0
run_test "complex scope with all allowed chars" "fix(a/b.c_d-e): complex scope" 0
run_test "docs type" "docs: update readme" 0
run_test "perf type" "perf: optimize queries" 0
run_test "test type" "test: add unit tests" 0
run_test "build type" "build: update dependencies" 0
run_test "ci type" "ci: configure github actions" 0
run_test "chore type" "chore: tidy up repository" 0
run_test "revert type" "revert: revert previous commit" 0
run_test "multiline body without backticks" "feat(api): add status endpoint

This is the body explaining the rationale.
Multiple lines of text with single quotes 'like this' and double quotes \"like this\".

Resolves #123" 0
run_test "comments with backticks allowed" "# Instructions: use \`git commit\` to save
feat: add versioning
# More comments with \`code\`" 0
run_test "leading comments and blank lines" "# Header comment with \`backtick\`

feat(dashboard): add version mismatch banner
" 0

# 3. Invalid Types (Exit 1)
echo "--- Group 3: Invalid Types ---"
run_test "feature instead of feat" "feature: invalid type" 1
run_test "bugfix instead of fix" "bugfix: invalid type" 1
run_test "capitalized Fix" "Fix: capitalized type" 1
run_test "uppercase FEAT" "FEAT: uppercase type" 1
run_test "wip type" "wip: work in progress" 1
run_test "arbitrary type" "random: some description" 1
run_test "freeform subject without type" "just a commit message without conventional prefix" 1

# 4. Invalid Formatting (Exit 1)
echo "--- Group 4: Invalid Formatting ---"
run_test "no space after colon" "feat:no space after colon" 1
run_test "empty description with space" "feat: " 1
run_test "empty description no space" "feat:" 1
run_test "empty scope" "feat(): empty scope" 1
run_test "space in scope" "feat(foo bar): space in scope" 1
run_test "special char in scope (@)" "feat(@scope): special char" 1
run_test "special char in scope (comma)" "feat(scope1,scope2): comma in scope" 1

# 5. Backtick Rejections (Exit 1)
echo "--- Group 5: Backtick Rejections ---"
run_test "backtick in subject" "feat: add \`code\` snippet" 1
run_test "backtick in scope" "feat(\`api\`): add endpoint" 1
run_test "backtick in body" "feat: add new feature

Detailed description with \`inline code\` backtick." 1
run_test "backtick in multiline codeblock" "feat: add feature

\`\`\`
code block
\`\`\`" 1

# 6. Empty & Comment-Only Messages (Exit 1)
echo "--- Group 6: Empty Messages ---"
run_test "completely empty file" "" 1
run_test "only whitespace lines" "   

   " 1
run_test "only comment lines" "# Just a comment
# Another comment line" 1
run_test "only comment lines with backticks" "# Comment with \`backticks\`
# Another \`comment\`" 1

echo "=========================================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed."
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
