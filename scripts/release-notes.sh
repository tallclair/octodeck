#!/usr/bin/env bash
set -euo pipefail

# scripts/release-notes.sh
# Collects the user-facing changes in a commit range from Conventional Commits
# history and prints them as categorized Markdown. The output is meant as input
# for writing release notes (by a person or an LLM), so each entry carries its
# full commit body, not just the subject.
#
# Usage: ./scripts/release-notes.sh [FROM_REF] [TO_REF]
#
# Categories (each commit lands in exactly one):
#   1. Breaking Changes   any type with '!' before the colon, or a
#                         'BREAKING CHANGE:' / 'BREAKING-CHANGE:' footer
#   2. Major Features     feat commits with a 'Release-Note: major' footer
#   3. Other Enhancements remaining feat commits
#   4. Bug Fixes          fix commits
#
# Everything else (other commit types, non-conventional subjects, commits with a
# 'Release-Note: none' footer, and commits reverted within the range along with
# the reverts themselves) is listed by subject only under "Omitted", so a reader
# can still spot a user-visible change filed under another type. Merge commits
# are skipped entirely.
#
# Guidance on turning this output into release notes lives in the release skill
# (.agents/skills/release/SKILL.md).

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

# 3. Determine Commit Range
if [ -n "$FROM_REF" ]; then
    RANGE="${FROM_REF}..${TO_REF}"
else
    RANGE="${TO_REF}"
fi

# 4. Load Commits (oldest first, so follow-up commits read in order)
# Records are NUL-terminated; fields are separated by the ASCII unit separator.
shas=()
declare -A short_shas=()
declare -A subjects=()
declare -A bodies=()
while IFS=$'\x1f' read -r -d '' sha short subject body; do
    shas+=("$sha")
    short_shas[$sha]="$short"
    subjects[$sha]="$subject"
    bodies[$sha]="$body"
done < <(git log "$RANGE" --no-merges --reverse -z --format="%H%x1f%h%x1f%s%x1f%b")

# 5. Resolve Reverts
# A commit is dropped if it was reverted within the range, unless that revert
# was itself reverted (a re-land). Revert commits are never listed themselves.
revert_re="This reverts commit ([0-9a-f]{40})"
declare -A reverts=()   # revert sha -> reverted sha
declare -A reverted=()  # reverted sha -> 1
for sha in "${shas[@]}"; do
    if [[ "${bodies[$sha]}" =~ $revert_re ]]; then
        reverts[$sha]="${BASH_REMATCH[1]}"
    fi
done
for sha in "${!reverts[@]}"; do
    reverted[${reverts[$sha]}]=1
done
declare -A dropped=()
for sha in "${!reverts[@]}"; do
    dropped[$sha]=1
    if [ -z "${reverted[$sha]:-}" ]; then
        dropped[${reverts[$sha]}]=1
    fi
done

# 6. Categorize
subject_re="^([a-z]+)(\(([^\)]+)\))?(!)?:[[:space:]]+(.*)$"

breaking=()
major=()
enhancements=()
fixes=()
declare -A types=()
declare -A scopes=()
declare -A descriptions=()
omitted=()
declare -A omit_reasons=()

omit() {
    omitted+=("$1")
    omit_reasons[$1]="${2:-}"
}

release_note_value() {
    # Prints the lowercased value of the last 'Release-Note:' footer, if any.
    printf '%s\n' "$1" | sed -n 's/^[Rr][Ee][Ll][Ee][Aa][Ss][Ee]-[Nn][Oo][Tt][Ee]:[[:space:]]*//p' \
        | tail -n 1 | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

for sha in "${shas[@]}"; do
    subject="${subjects[$sha]}"
    body="${bodies[$sha]}"
    if [ -n "${dropped[$sha]:-}" ]; then
        if [ -n "${reverts[$sha]:-}" ]; then
            omit "$sha" "revert"
        else
            omit "$sha" "reverted"
        fi
        continue
    fi
    if ! [[ "$subject" =~ $subject_re ]]; then
        omit "$sha"
        continue
    fi

    type="${BASH_REMATCH[1]}"
    scope="${BASH_REMATCH[3]}"
    bang="${BASH_REMATCH[4]}"
    description="${BASH_REMATCH[5]}"

    note=$(release_note_value "$body")
    if [ "$note" = "none" ]; then
        omit "$sha" "Release-Note: none"
        continue
    fi

    types[$sha]="$type"
    scopes[$sha]="$scope"
    descriptions[$sha]="$description"

    if [ "$type" != "revert" ] && { [ -n "$bang" ] || printf '%s\n' "$body" | grep -Eq '^BREAKING[ -]CHANGE:'; }; then
        breaking+=("$sha")
    elif [ "$type" = "feat" ]; then
        if [ "$note" = "major" ]; then
            major+=("$sha")
        else
            enhancements+=("$sha")
        fi
    elif [ "$type" = "fix" ]; then
        fixes+=("$sha")
    else
        omit "$sha"
    fi
done

# 7. Output Markdown
clean_body() {
    # Drops bookkeeping trailers and surrounding blank lines from a commit body.
    printf '%s\n' "$1" \
        | grep -Eiv '^(Release-Note|Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Change-Id):' \
        | awk 'NF { started = 1 } started { lines[++n] = $0 } END { while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print lines[i] }'
}

print_entry() {
    local sha="$1"
    local scope="${scopes[$sha]}"
    local body
    body=$(clean_body "${bodies[$sha]}")

    echo ""
    if [ -n "$scope" ]; then
        printf '### %s: %s\n' "$scope" "${descriptions[$sha]}"
    else
        printf '### %s\n' "${descriptions[$sha]}"
    fi
    printf 'Commit: %s | Type: %s | Scope: %s\n' "${short_shas[$sha]}" "${types[$sha]}" "${scope:-none}"
    if [ -n "$body" ]; then
        echo ""
        printf '%s\n' "$body"
    fi
}

print_section() {
    local title="$1"
    shift
    [ "$#" -eq 0 ] && return 0
    echo ""
    echo "## $title"
    local sha
    for sha in "$@"; do
        print_entry "$sha"
    done
}

included=$((${#breaking[@]} + ${#major[@]} + ${#enhancements[@]} + ${#fixes[@]}))

echo "# Release Notes Input (${RANGE})"
echo ""
echo "Commits: ${#shas[@]} | Included: ${included} | Omitted: ${#omitted[@]}"
if [ "$included" -eq 0 ]; then
    echo ""
    echo "No user-facing changes found."
fi

print_section "Breaking Changes" "${breaking[@]+"${breaking[@]}"}"
print_section "Major Features" "${major[@]+"${major[@]}"}"
print_section "Other Enhancements" "${enhancements[@]+"${enhancements[@]}"}"
print_section "Bug Fixes" "${fixes[@]+"${fixes[@]}"}"

if [ "${#omitted[@]}" -gt 0 ]; then
    echo ""
    echo "## Omitted"
    echo ""
    for sha in "${omitted[@]}"; do
        if [ -n "${omit_reasons[$sha]}" ]; then
            printf -- '- %s %s (%s)\n' "${short_shas[$sha]}" "${subjects[$sha]}" "${omit_reasons[$sha]}"
        else
            printf -- '- %s %s\n' "${short_shas[$sha]}" "${subjects[$sha]}"
        fi
    done
fi
