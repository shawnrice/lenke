#!/usr/bin/env bash
# Items 1756/1758/1759 shipped three wins across FOUR source files, one of them in core — and every
# measurement was taken on an INDEXED fixture. This is the unindexed regression pass they owe.
#
# ⚠️ IT NOMINATES, IT DOES NOT PRICE (item 1747): few readings per arm make a "disjoint" verdict too
# easy, and `filterchain` is BIMODAL. Re-measure any flagged row on its own at 300+ reps.
set -u
R=/home/shawn/projects/pl-graph
T=$R/crates/lenke-engine/target/prefam
declare -A DEST=(
  [PropertyIndex.ts]=$R/packages/core/src/core/PropertyIndex.ts
  [matching.ts]=$R/packages/gql/src/executor/matching.ts
  [index-seed.ts]=$R/packages/gremlin/src/executor/index-seed.ts
  [node-values.ts]=$R/packages/gremlin/src/executor/node-values.ts
)
put() { for n in "${!DEST[@]}"; do cp "$1/$2$n" "${DEST[$n]}"; done; }

for round in 1 2; do
  for arm in prefam head; do
    if [ "$arm" = prefam ]; then put "$T" ""; else put "$T" "HEAD-"; fi
    (cd "$R/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED core"; continue; }
    (cd "$R/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED gql"; continue; }
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED gremlin"; continue; }
    got=$(python3 -c "
t=open('$R/packages/gql/dist/esm/index.mjs',encoding='utf-8',errors='replace').read()
u=open('$R/packages/gremlin/dist/esm/index.mjs',encoding='utf-8',errors='replace').read()
a = 'countRangeAtMost' in t
b = 'rangeCap' in u
print('head' if (a and b) else 'prefam' if (not a and not b) else f'HALF a={a} b={b}')
")
    [ "$got" = "$arm" ] || { echo "ARM-ASSERT-FAILED $arm saw $got"; continue; }
    echo "arm-assert ok   $arm"
    # UNINDEXED GQL shapes (the screens' own fixture has no index)
    # UNINDEXED GQL shapes (the screens' own fixture has no index)
    for s in ${GQLSHAPES:-hopfilter hopall point distinct wideproj existssub sortedpage grouped join optional}; do
      printf 'R%s %s gql ' "$round" "$arm"
      (cd "$R/packages/native" && timeout 600 node runtime-profile-probe.mjs "$s" ${QREPS:-400} 2>&1 | tail -1)
    done
    # UNINDEXED Gremlin shapes
    for s in hopcount3 filterchain hophas coalesced folded valuesonly selected repeated; do
      printf 'R%s %s grem ' "$round" "$arm"
      (cd "$R/packages/native" && timeout 600 node runtime-profile-gremlin-probe.mjs "$s" ${GREPS:-60} 2>&1 | tail -1)
    done
  done
done
put "$T" "HEAD-"
(cd "$R/packages/core" && bun run build > /dev/null 2>&1)
(cd "$R/packages/gql" && bun run build > /dev/null 2>&1)
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo SWEEP-DONE
