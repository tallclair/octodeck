# Shared helper for running verification steps in parallel with clean output.
# Source this file (POSIX sh), then:
#
#   par_start                         # once, before any par_run
#   par_run <name> <command> [args]   # start a step in the background
#   par_wait                          # wait for every step; non-zero if any failed
#
# Each step's output is captured to its own log. A PASS/FAIL line with the
# elapsed time is printed as each step finishes, and par_wait prints the full
# log of every failed step at the end, so output never interleaves. Step names
# must be unique words. After par_wait, PAR_FAILED lists the failed steps.
#
# Each step runs in its own process group (job control), so an interrupt stops
# whole process trees; non-interactive shells otherwise start background jobs
# with SIGINT ignored. Nested use is supported: when an outer runner stops a
# step whose script itself uses par_*, that script's trap stops its own steps.

par_start() {
    PAR_DIR=$(mktemp -d)
    PAR_PIDS=""
    PAR_NAMES=""
    PAR_FAILED=""
    set -m
    trap 'echo; echo "Interrupted."; par_cleanup; exit 130' INT TERM
}

par_cleanup() {
    for pid in $PAR_PIDS; do
        kill -TERM -- "-$pid" 2>/dev/null
    done
    rm -rf "$PAR_DIR"
}

# _par_step <name> <command> [args]: runs in the background via par_run.
_par_step() {
    name=$1
    shift
    start=$(date +%s)
    "$@" > "$PAR_DIR/$name.log" 2>&1 < /dev/null
    rc=$?
    echo "$rc" > "$PAR_DIR/$name.rc"
    if [ "$rc" -eq 0 ]; then status="PASS"; else status="FAIL"; fi
    printf '  %s  %-10s %4ss\n' "$status" "$name" "$(($(date +%s) - start))"
}

par_run() {
    name=$1
    shift
    echo "$*" > "$PAR_DIR/$name.cmd"
    PAR_NAMES="$PAR_NAMES $name"
    _par_step "$name" "$@" &
    PAR_PIDS="$PAR_PIDS $!"
}

par_wait() {
    wait
    PAR_PIDS=""
    trap - INT TERM
    set +m

    PAR_FAILED=""
    for name in $PAR_NAMES; do
        if [ "$(cat "$PAR_DIR/$name.rc" 2>/dev/null)" != "0" ]; then
            PAR_FAILED="$PAR_FAILED $name"
        fi
    done
    for name in $PAR_FAILED; do
        echo
        echo "===== $name: $(cat "$PAR_DIR/$name.cmd") ====="
        cat "$PAR_DIR/$name.log"
    done
    rm -rf "$PAR_DIR"
    [ -z "$PAR_FAILED" ]
}
