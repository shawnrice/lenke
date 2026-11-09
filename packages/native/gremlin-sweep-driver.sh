#!/usr/bin/env bash
# A two-arm sweep over the whole Gremlin shape corpus, for the REGRESSION pass after a change to a
# hot shared path. Point PRE and NOW at two versions of one file.
#
# ⚠️ IT NOMINATES, IT DOES NOT PRICE, and item 1747 is why. At the default 40 reps and 2 readings per
# arm a "disjoint" verdict is far too easy to reach: `filterchain` came back SLOWER 1.42x and an
# isolated 9-reading run at 300 reps showed the shape is BIMODAL (~38 ms and ~62 ms modes, both arms
# hitting both in near-equal proportion), so the sweep had simply caught one arm low and the other
# high. The same inflation runs the other way: `coalesced` read 1.63x here against a properly
# measured 1.20x. **Re-measure every row that matters on its own, at 300+ reps and 9 readings.**
#
#     REPS=300 bash zz-sweep-1747.sh        # or narrow SHAPES to one row, repeated 3x
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gremlin/src/executor/runtime.ts
PRE=$R/crates/lenke-engine/target/pristine-1745-base.ts     # before item 1745
NOW=$R/crates/lenke-engine/target/pristine-1747-head.ts     # HEAD (1745 + 1746)
D=$R/packages/gremlin/dist/esm/index.mjs
SHAPES="control hopcount3 hopcount2 hopbare hoporder grouped filterchain hopdedupe hophas projected valuemapped coalesced selected groupreduce folded valuesonly valuestwo hopvaluesrows hopidrows hop2valuesrows hop2idrows hop3valuesrows point pointcount hop2trailinghas hop2midhas repeated matched matched2 matchedsel localized localfloor localvalues optionald coalesced2 branchfloor optionalvalues coalescevalues branchvaluesfloor hopordercap hoporderdesc hopfarhasvalues hopvaluesn hopfarhasid unioncount bothcount"
for round in 1 2 3; do
  for arm in pre now; do
    if [ "$arm" = pre ]; then cp "$PRE" "$S"; else cp "$NOW" "$S"; fi
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
spread = 'prev.sack === void 0' in t or 'prev.sack === undefined' in t
print('pre' if spread else 'now')
")
    [ "$got" = "$arm" ] || { echo "ARM-ASSERT-FAILED $arm saw $got"; continue; }
    for s in $SHAPES; do
      printf 'R%s %s ' "$round" "$arm"
      (cd "$R/packages/native" && timeout 600 node runtime-profile-gremlin-probe.mjs "$s" ${REPS:-40} 2>&1 | tail -1)
    done
  done
done
cp "$NOW" "$S"
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo SWEEP-DONE
