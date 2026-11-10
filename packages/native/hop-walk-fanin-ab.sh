#!/usr/bin/env bash
# Item 1779: THE FAN-IN SWEEP ITEM 1777 ASKED FOR, on the walk choice NO GATE GUARDS.
#
# `hop-projection.ts`'s SINGLE-TYPE exit takes the far-driven walk UNCONDITIONALLY whenever the
# start label is vacuous:
#
#     !startDrivenForOrder && (startLabel === undefined || vacuousLabel(graph, startLabel))
#       ? farDriven(graph, params)
#       : startDriven(graph, params)
#
# There is no degree term in it. `farDrivenPaysForMultiType` — the gate items 1390, 1404, 1406 and
# 1434 measured, swept and re-thresholded — guards only the MULTI-TYPE exit above it. So the
# single-type walk choice has never been read against its alternative at any fan-in, and item 1777
# stumbled into the first evidence that it is wrong at the low end: `hopoffset` (forced start-driven)
# measured **1.28x FASTER than `hoplist`** (far-driven), the PAGED query beating the unpaged one over
# ten more rows, on a fixture whose fan-in is exactly 1.
#
# ⚠️ ONE FIXTURE AND ONE CELL IS NOT A VERDICT, which is why this exists. Item 1390 measured the
# far-driven walk at 86.1 against 69.3 at `FANIN=1` and **16.1** at `FANIN=0.01` — a refutation and
# a 4.3x win from the same code, decided entirely by the knob. A single-cell reading of this route
# would be the same mistake with the sign flipped.
#
# THE ARMS ARE TWO QUERIES IN ONE BUILD, which is what makes this cheap and trustworthy:
#
#     unpaged  MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n             far-driven
#     paged    MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n OFFSET 1    start-driven
#
# Item 1777 gave `hopOrderPlan` a `pageSkip !== 0` arm of its `startDriven` flag, so `OFFSET 1` is a
# start-driven forcer: same detector, same exit, same walk machinery, ONE fewer row out of NODES.
# No source edit, no rebuild between arms, so item 737's cross-build trap cannot apply — the same
# trick items 1776-1778 used, in the other direction.
#
# Interleaved per cell (item 1367: the noise is PROCESS-level), one shape per PROCESS (item 762),
# `p25` per process and the median across rounds. Every run is capped per CLAUDE.md, because a probe
# over a generated fixture is exactly what took the box down.
#
#   ./hop-walk-fanin-ab.sh                      # the single-type sweep, 6 cells
#   SHAPES='hopmultiyield hopmultiyieldpage' MULTILABEL=-1 ./hop-walk-fanin-ab.sh
set -u
R=/home/shawn/projects/pl-graph

NODES=${NODES:-200000}
REPS=${REPS:-14}
ROUNDS=${ROUNDS:-3}
MULTILABEL=${MULTILABEL:-0}
STRIDE=${STRIDE:-random}
SHAPES=${SHAPES:-'hopsingleyield hopsingleyieldpage'}
FANINS=${FANINS:-'1 0.1 0.01'}
FANOUTS=${FANOUTS:-'1 4'}

echo "# nodes=$NODES reps=$REPS rounds=$ROUNDS multilabel=$MULTILABEL stride=$STRIDE"
echo "# shapes=$SHAPES fanins=$FANINS fanouts=$FANOUTS"

for fanout in $FANOUTS; do
  for fanin in $FANINS; do
    for round in $(seq 1 "$ROUNDS"); do
      for shape in $SHAPES; do
        printf 'cell fanout=%s fanin=%s round=%s shape=%s ' "$fanout" "$fanin" "$round" "$shape"
        SHAPE="$shape" NODES="$NODES" REPS="$REPS" FANIN="$fanin" FANOUT="$fanout" \
          MULTILABEL="$MULTILABEL" STRIDE="$STRIDE" \
          timeout 600 systemd-run --user --scope -q \
          -p MemoryMax=16G -p MemorySwapMax=0 \
          node "$R/packages/native/isolated-row-bench.mjs" 2>&1 | tail -1
      done
    done
  done
done
