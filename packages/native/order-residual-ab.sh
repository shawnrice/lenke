#!/usr/bin/env bash
# Item 1783: does admitting `order` as a residual over the bare hop pay, and what does it cost the
# rows it cannot reach?
#
# Item 1782 ranked `V().out(T).order().by(k)` as the heaviest row on the Gremlin bench (1537.5
# ns/row) and verified with route markers that it takes NO shortcut at all — `hopValuesShortcut`
# needs a `values()` step, so an `order` third step declined the whole thing and the row fell to the
# generic traverser pipeline. The change is one named step kind admitted to the gate's bare-hop arm.
#
# ⚠️ THIS IS A CROSS-BUILD A/B, which item 737 is the warning about — a sweep comparing two builds
# reported a 1.66x regression that did not exist. The mitigations are the ones that item and item 439
# settled on, and all three are here:
#
#   * ALTERNATED ROUNDS, so machine drift cannot land on one arm.
#   * ONE SHAPE PER PROCESS (item 762), so no other shape pollutes the dispatch.
#   * EVERY ARM ASSERTED TO BE ITS OWN CODE BEFORE IT IS MEASURED. `cp` of a file that was never
#     written leaves the previous arm in place and the "after" reading is the "before" code — a null
#     that looks like a result. The assertion is a COUNT, not a presence test (item 1744): the
#     string `=== "order"` already occurs twice in the base bundle, so the arms are 2 and 3.
#
# CONTROLS MATTER MORE THAN THE TARGET HERE. `hopValuesShortcut` is consulted by every plan, so the
# rows this change cannot reach are where a regression would hide: `hoporderstr` and `hoporder` ride
# `fusedProjectedOrder` (value mode, untouched), `hopbare` is the bare hop with no residual, and
# `hopyieldsingle` is the fused value walk.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gremlin/src/executor/hop-values.ts
BASE=$R/crates/lenke-engine/target/pristine-1783/hop-values.ts
NEW=$R/crates/lenke-engine/target/pristine-1783/hop-values-NEW.ts
D=$R/packages/gremlin/dist/esm/index.mjs

NODES=${NODES:-100000}
REPS=${REPS:-14}
ROUNDS=${ROUNDS:-3}
FANIN=${FANIN:-1}
SHAPES=${SHAPES:-'hoporderbystr hoporderstr hoporder hopbare hopyieldsingle'}

assert_arm() {
  local arm="$1" got
  got=$(python3 -c "
t = open('$D', encoding='utf-8', errors='replace').read()
n = t.count('=== \"order\"')
print({2: 'base', 3: 'residual'}.get(n, f'UNEXPECTED-{n}'))
")
  if [ "$got" != "$arm" ]; then
    echo "ARM-ASSERT-FAILED want=$arm saw=[$got]"
    return 1
  fi
  echo "# arm-assert ok   $arm"
  return 0
}

for round in $(seq 1 "$ROUNDS"); do
  for arm in base residual; do
    if [ "$arm" = base ]; then cp "$BASE" "$S"; else cp "$NEW" "$S"; fi
    (cd "$R/packages/gremlin" && timeout 900 bun run build > /dev/null 2>&1) || {
      echo "BUILD-FAILED $arm"
      continue
    }
    assert_arm "$arm" || continue

    for s in $SHAPES; do
      printf 'arm=%s round=%s shape=%s ' "$arm" "$round" "$s"
      SHAPE="$s" NODES="$NODES" REPS="$REPS" FANIN="$FANIN" FANOUT=1 MULTILABEL=-1 VLABEL=3 \
        STRIDE=random \
        timeout 600 systemd-run --user --scope -q \
        -p MemoryMax=16G -p MemorySwapMax=0 \
        node "$R/packages/native/isolated-gremlin-bench.mjs" 2>&1 | tail -1
    done
  done
done

# Leave the tree on the NEW arm, which is what the item ships, and say so out loud.
cp "$NEW" "$S"
(cd "$R/packages/gremlin" && timeout 900 bun run build > /dev/null 2>&1)
assert_arm residual
echo "# tree left on the RESIDUAL arm"
