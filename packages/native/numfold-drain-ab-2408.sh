#!/bin/zsh
# Item 2408 — does `foldProjectedNumeric` want item 1919's EAGER DRAIN, as its `min`/`max` twin does?
#
# ⚠️⚠️ THE QUESTION IS NOT RHETORICAL AND THE FIRST GUESS WAS "NO". Item 1919 took the drain for
# `foldProjectedMinMax` and priced it at 2.09x on a STRING column but only 1.15x on a numeric one —
# and a `sum` column is numeric BY CONSTRUCTION (`asNumber` throws otherwise), so the drain looked
# like an 800,000-slot allocation bought for ~15% on a reduce that needs one accumulator.
#
# 🔑 WHAT NOMINATED IT ANYWAY IS THE TWIN'S OWN NUMBER IN THE SAME RUN. After the fusion landed:
#
#       values(k)         62.18 ms   <- the floor
#       values(k).min()   65.51      <- DRAINS (item 1919): 1.05x over the floor
#       values(k).sum()   97.77      <- ITERATES: 1.57x over the same floor
#
# Two folds over the same walk, one at the floor and one not, differing in exactly the drain. That
# is item 1919's finding restated, so it gets measured here rather than reasoned about.
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE, interleaved and order-alternated, each asserted before it is
# measured, with a restore trap to ITER — same discipline as `numfold-ab-2408.sh`, and for the same
# reason: a sequential pair of readings on this box moved three unreachable controls 1.44-1.73x.
#
#     ROUNDS=3 zsh numfold-drain-ab-2408.sh
set -e
set -u

ROOT=/home/shawn/projects/pl-graph
AGG="$ROOT/packages/gremlin/src/executor/aggregation.ts"
ROUNDS="${ROUNDS:-3}"
ARMS="${ARMS:-sum mean values min}"

# ⚠️ `values` IS THE UNIQUE PART: `foldProjectedMinMax` iterates `src`, not `values`, so this anchor
# cannot reach the twin. Counted, not assumed — the first A/B here anchored on a line that occurred
# TWICE ([[ambiguous-anchor-strings]]).
ITER_LINE="  for (const v of values) {"
DRAIN_LINE="  for (const v of values.drain === undefined ? values : values.drain()) {"

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
  if [[ "$1" == DRAIN ]]; then
    swap "$ITER_LINE" "$DRAIN_LINE"
  else
    swap "$DRAIN_LINE" "$ITER_LINE"
  fi
}

assert_arm() {
  local want="$1" iter drain
  iter=$(count "$ITER_LINE")
  drain=$(count "$DRAIN_LINE")

  # ⚠️ THE DRAIN LINE CONTAINS NO COPY OF THE ITER LINE, so the two counts are independent.
  if [[ "$want" == ITER && ( "$iter" -ne 1 || "$drain" -ne 0 ) ]]; then
    echo "ARM ASSERTION FAILED: want ITER, iter=$iter drain=$drain"
    exit 3
  fi
  if [[ "$want" == DRAIN && ( "$drain" -ne 1 || "$iter" -ne 0 ) ]]; then
    echo "ARM ASSERTION FAILED: want DRAIN, drain=$drain iter=$iter"
    exit 3
  fi
  echo "# arm=$want verified (iter=$iter drain=$drain)"
}

restore_live() {
  set_arm ITER
  (cd "$ROOT" && bun run build >/dev/null 2>&1) || true
  echo "# restored to ITER and rebuilt"
}
trap restore_live EXIT INT TERM

assert_arm ITER

for r in $(seq 1 "$ROUNDS"); do
  if (( r % 2 == 1 )); then
    order=(ITER DRAIN)
  else
    order=(DRAIN ITER)
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
