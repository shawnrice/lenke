#!/bin/zsh
# Item 2408 — interleaved A/B for the `sum`/`mean` projected fold.
#
# WHY INTERLEAVED, AND IT IS NOT INHERITED CAUTION — A SEQUENTIAL PRE/POST WAS RUN FIRST AND
# ITS CONTROLS MOVED MORE THAN A REAL WIN WOULD. `values` 91.94 -> 63.89 (1.44x), `min` 103.54 ->
# 67.87 (1.53x) and `strmin` 170.96 -> 98.84 (1.73x), on three arms this change cannot reach. That
# is CLAUDE.md's named giveaway for an artefact, so the sequential reading is discarded rather than
# reported. Item 1918's own A/B hit the same thing at ~12-14% and interleaving flattened it.
#
# THE ARMS ARE A ONE-LINE ROUTE TOGGLE, which is the narrowest possible A/B for this question:
# narrowing the gate sends `values(k).sum()` back down the generic residual and changes NOTHING
# else — `foldProjectedNumeric` stays defined and `index.ts` keeps its branch, merely unreachable.
# So the two arms differ only in which route the plan takes.
#
# NAMED FOR WHAT THEY ARE, not PRE/POST — [[name-ab-arms-for-what-they-are]] records the
# experiment ending up under the "PRE" label and its faster reading nearly becoming the baseline.
#   FUSED   = the live code, the fold taken
#   GENERIC = the gate narrowed to min/max, the pre-2408 route
#
# EACH ARM ASSERTS IT IS THE CODE IT CLAIMS BEFORE MEASURING, and the run starts and ends on
# FUSED with a restore trap, so a kill between the swap and the swap back cannot leave the tree on
# the wrong arm ([[ab-scripts-need-a-restore-trap]]).
#
#     ROUNDS=3 bun/zsh numfold-ab-2408.sh
set -e
set -u

ROOT=/home/shawn/projects/pl-graph
AGG="$ROOT/packages/gremlin/src/executor/aggregation.ts"
ROUNDS="${ROUNDS:-3}"
ARMS="${ARMS:-sum mean values min strmin}"

# THE ANCHOR CARRIES ITS DESTRUCTURING LINE, AND THE FIRST CUT DID NOT — `fusableValuesAggregate`
# twenty lines above tests the IDENTICAL four kinds, so the bare `if` matched TWICE and would have
# toggled the scan-side fusion along with the hop-side one. [[ambiguous-anchor-strings]]: count a
# string's occurrences before anchoring on it. The arm assertion below caught it (fused=2) before
# anything was measured, which is what it is for. `= step` is the projected gate; `= next` is the
# other one.
FUSED_LINE="  const { kind } = step;

  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {"
GENERIC_LINE="  const { kind } = step;

  if (kind !== 'min' && kind !== 'max') {"

# PYTHON, NOT `grep -c`: the anchors are MULTI-LINE and grep is line-based, so a line-wise count
# of either one is always 0 and every assertion would "pass" vacuously.
count() {
  FROM="$1" python3 -c "
import os,sys
sys.stdout.write(str(open(sys.argv[1]).read().count(os.environ['FROM'])))
" "$AGG"
}

swap() {
  FROM="$1" TO="$2" python3 -c "
import os,sys
p=sys.argv[1]; s=open(p).read(); f=os.environ['FROM']; t=os.environ['TO']
if s.count(f)==1:
    open(p,'w').write(s.replace(f,t))
" "$AGG"
}

set_arm() {
  local arm="$1"
  if [[ "$arm" == GENERIC ]]; then
    swap "$FUSED_LINE" "$GENERIC_LINE"
  else
    swap "$GENERIC_LINE" "$FUSED_LINE"
  fi
}

assert_arm() {
  local want="$1" fused generic
  fused=$(count "$FUSED_LINE")
  generic=$(count "$GENERIC_LINE")

  if [[ "$want" == FUSED && ( "$fused" -ne 1 || "$generic" -ne 0 ) ]]; then
    echo "ARM ASSERTION FAILED: want FUSED, fused=$fused generic=$generic"
    exit 3
  fi
  if [[ "$want" == GENERIC && ( "$generic" -ne 1 || "$fused" -ne 0 ) ]]; then
    echo "ARM ASSERTION FAILED: want GENERIC, generic=$generic fused=$fused"
    exit 3
  fi
  echo "# arm=$want verified (fused=$fused generic=$generic)"
}

restore_live() {
  set_arm FUSED
  (cd "$ROOT" && bun run build >/dev/null 2>&1) || true
  echo "# restored to FUSED and rebuilt"
}
trap restore_live EXIT INT TERM

# A start-of-run LIVE check: the tree must be on FUSED before anything is swapped.
assert_arm FUSED

for r in $(seq 1 "$ROUNDS"); do
  # ARM ORDER ALTERNATES BY ROUND, so neither arm is always the one that runs on a warm machine.
  if (( r % 2 == 1 )); then
    order=(FUSED GENERIC)
  else
    order=(GENERIC FUSED)
  fi

  for arm in $order; do
    set_arm "$arm"
    assert_arm "$arm"
    (cd "$ROOT" && bun run build >/dev/null 2>&1)

    for s in ${=ARMS}; do
      line=$(cd "$ROOT/packages/native" && timeout 600 systemd-run --user --scope -q \
        -p MemoryMax=16G -p MemorySwapMax=0 env SHAPE=$s bun minmax-prof-1918.mjs 2>&1 | head -1)
      echo "r$r $arm $line"
    done
  done
done
