#!/bin/zsh
# Item 2104 — hop2Projection's execution-time orientation decline, LIVE against a KILLED gate.
#
# ⚠️ THE KILL IS IN TWO PLACES, because the field feeds two consumers: GQL's `matchesLabel` and
# Gremlin's `labelOf`. Killing only one would measure half the change and look like a smaller win.
set -u
ROOT=/home/shawn/projects/pl-graph
GQL=$ROOT/packages/gql/src/executor/hop2-projection.ts

P_GQL=$ROOT/crates/lenke-engine/target/h2p.pristine.2104ab.ts

ROUND=${ROUND:-LIVE}
REPS=${REPS:-11}

[[ -f $P_GQL ]]  || cp "$GQL"  "$P_GQL"


restore_live() {
  cp "$P_GQL" "$GQL"
  (cd $ROOT && npx nx build @lenke/gql >/dev/null 2>&1)
}
# ⚠️ A kill between the swap and the swap back would leave the tree on the WRONG arm, still green.
trap restore_live EXIT INT TERM

# ⚠️ ASSERT THE TREE IS LIVE BEFORE DOING ANYTHING — if a previous run died mid-swap, the "before"
# reading would silently be the killed code.
grep -qF 'shouldDeclineToOrientedMatcher(graph, cPath, params) ? null' "$GQL" || { print -- "TREE IS NOT LIVE — restore first"; exit 1; }

case $ROUND in
  LIVE)   : ;;
  KILLED)
    # Force both consumers down the old path. The field is still maintained; only the READS go.
    # Kill by making the rung decline ALWAYS, so every query falls to `countShortcut` as before.
    # Kill the decline: always answer, as before item 2104.
    sed -i "s@    shouldDeclineToOrientedMatcher(graph, cPath, params) ? null : answered(graph, params);@    false ? null : answered(graph, params); // KILLED 2104@" "$GQL" || exit 1
    grep -cF '// KILLED 2104' "$GQL" | grep -q '^1$' || { print -- "GQL KILL NOT SET"; exit 1; }
    (cd $ROOT && npx nx build @lenke/gql >/dev/null 2>&1; npx nx build @lenke/gremlin >/dev/null 2>&1)
    ;;
  RESTORE) print -- "restored + rebuilt"; exit 0 ;;
  *) print -- "ROUND must be LIVE | KILLED | RESTORE"; exit 1 ;;
esac

print -- "=== $ROUND ==="

# ⚠️ PLAIN ARRAYS, NO CLEVER DEFAULTS. Two earlier scripts in this directory lost a whole round to
# `${=:-${ROWS:-"a\nb"}}`: a row name contains a space, `local IFS` is invalid outside a function,
# and the loop silently ran one row. The lists are literal here.
gqlrows=(hop2rows hop2distinct hop2rowswhere hoprows control)
gremrows=()

for sh in $gqlrows; do
  out=$(NODES=200000 timeout 1800 node $ROOT/packages/native/runtime-profile-probe.mjs $sh $REPS 2>&1 | tail -1)
  parsed=$(print -r -- "$out" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(f\"{d['ms'] / $REPS:.2f} ms/rep   answer={d['answer']}\")
except Exception as e:
    print('PARSE-FAILED', e)
")
  print -r -- "  gql  $sh  $parsed"
done

for row in $gremrows; do
  line=$(NODES=200000 REPS=$REPS ONLY="=$row" MIXED=0 timeout 900 bun $ROOT/packages/native/gremlin-workload-screen.mjs 2>&1 | grep -F "   $row" | tail -1)
  print -r -- "  grem $row  $(print -r -- "$line" | awk '{print $1" ms  rows="$2}')"
done
