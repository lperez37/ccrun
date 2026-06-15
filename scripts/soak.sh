#!/usr/bin/env bash
# Soak test: run ccrun many times and report the real success/failure rate.
# Each run gets a unique token and must echo it back AND write it to a file, so
# we catch silent wrong-output failures, not just non-zero exits.
#
# Usage:  scripts/soak.sh [RUNS] [CONCURRENCY]
#   RUNS         total runs (default 50)
#   CONCURRENCY  how many run at once (default 5)
#
# Needs a built ccrun on PATH (or run `npm run build` first and use node dist).
set -uo pipefail

RUNS="${1:-50}"
CONCURRENCY="${2:-5}"
CCRUN="${CCRUN:-ccrun}"
command -v "$CCRUN" >/dev/null || CCRUN="node $(dirname "$0")/../dist/cli.js"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccrun-soak.XXXXXX")"
echo "soak: $RUNS runs, concurrency $CONCURRENCY, workdir $ROOT"
echo "binary: $CCRUN"

one_run() {
  local i="$1" d="$ROOT/r$i" tok="SOAK_${i}_OK"
  mkdir -p "$d"; (cd "$d" && git init -q 2>/dev/null)
  local out rc
  out="$($CCRUN --quiet --cwd "$d" --timeout 180 \
        "Write the token $tok to a file called tok.txt, then reply with exactly $tok." 2>"$d/err")"
  rc=$?
  local file; file="$(tr -d '\n' < "$d/tok.txt" 2>/dev/null)"
  if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q "$tok" && [ "$file" = "$tok" ]; then
    echo "PASS" > "$d/verdict"
  else
    echo "FAIL rc=$rc out='$(printf '%s' "$out" | head -c 80)' file='$file'" > "$d/verdict"
  fi
}

start=$(date +%s)
running=0
for i in $(seq 1 "$RUNS"); do
  one_run "$i" &
  running=$((running+1))
  if [ "$running" -ge "$CONCURRENCY" ]; then wait -n 2>/dev/null || wait; running=$((running-1)); fi
done
wait

pass=0; fail=0
for i in $(seq 1 "$RUNS"); do
  v="$(cat "$ROOT/r$i/verdict" 2>/dev/null || echo 'FAIL (no verdict)')"
  case "$v" in
    PASS) pass=$((pass+1)) ;;
    *) fail=$((fail+1)); echo "run $i: $v" ;;
  esac
done
elapsed=$(( $(date +%s) - start ))

echo "----------------------------------------"
echo "runs=$RUNS pass=$pass fail=$fail  (${elapsed}s)"
awk "BEGIN { printf \"success rate: %.1f%%\n\", ($pass/$RUNS)*100 }"
echo "leftover ccrun sockets: $(find "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)" -maxdepth 1 -name 'ccrun-*' 2>/dev/null | wc -l)"
echo "workdir kept at $ROOT (rm -rf when done)"
[ "$fail" -eq 0 ]
