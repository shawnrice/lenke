#!/usr/bin/env bash
# Item 1767's A/B: does collapsing `countEquals` + `equals` into ONE bucket fetch in GQL's
# `eqCandidate` pay? Nominated by `countEquals` at 7.1% of a parameterised edge INSERT, where
# two endpoints each pay the gate's count AND the seed's fetch for the same (key, value).
#
# ⚠️ THE DIST IS ASSERTED PER ARM, by COUNT, keyed on a symbol the mutation UNIQUELY produces
# (`seedBucket1767`). An arm that silently failed to build is otherwise the previous arm's code
# measured twice, which reads as a clean null.
#
# ⚠️ ORDER IS ALTERNATED across rounds: these shapes drift with what the machine did before them.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

S=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad
LOG="$S/eqcand-ab-$(date +%s).log"
touch "$LOG"

# TARGETS seek by an indexed property; CONTROLS cannot reach `eqCandidate` at all.
#   insertedgep  two exact seeds per write  — the nominating shape
#   setp         one exact seed per write
#   insertp      no MATCH, so no seed       — the control
SHAPES="insertedgep setp insertp"

run_arm() {
  local arm="$1"
  python3 -I "$S/eqcand-1767.py" "$arm" >>"$LOG" 2>&1 || return 1
  bunx nx build @lenke/gql >>"$LOG" 2>&1 || { echo "BUILD-FAILED $arm"; return 1; }

  local want got
  if [ "$arm" = post ]; then want=3; else want=0; fi
  got=$(python3 -I -c "
import pathlib
print(pathlib.Path('packages/gql/dist/esm/index.mjs').read_text(encoding='utf-8',errors='replace').count('seedBucket1767'))
")
  if [ "$got" != "$want" ]; then
    echo "DIST-ASSERT-FAILED arm=$arm seedBucket1767=$got want=$want"
    return 1
  fi
  echo "  dist ok ($arm: $got)"

  for s in $SHAPES; do
    printf '  %-18s %s ' "$s" "$arm"
    (cd packages/native && INDEXED=1 SHAPE="$s" BATCH=20000 SEED=20000 ROUNDS=5 \
      node gql-write-probe.mjs) | python3 -I -c "
import json,sys
print(json.load(sys.stdin)['usPerWrite'], 'us/write')
"
  done
}

for round in 1 2 3; do
  echo "=== round $round ==="
  if [ $((round % 2)) -eq 1 ]; then order="pre post"; else order="post pre"; fi
  for arm in $order; do
    run_arm "$arm" || { echo "ABORT: arm $arm failed; see $LOG"; python3 -I "$S/eqcand-1767.py" pre; exit 1; }
  done
done

# ⚠️ RESTORE BEFORE EXIT, not only on success: an interrupted run otherwise leaves the mutation in
# the tree with `git diff` the only thing between it and a commit.
python3 -I "$S/eqcand-1767.py" pre
echo "restored; log at $LOG"
