#!/usr/bin/env bash
# Item 1756: cap the range candidate's count at the gate's own threshold.
set -u
R=/home/shawn/projects/pl-graph
T=$R/crates/lenke-engine/target
PI=$R/packages/core/src/core/PropertyIndex.ts
M=$R/packages/gql/src/executor/matching.ts
D=$R/packages/gql/dist/esm/index.mjs
for round in 1 2 3; do
  for arm in base capped; do
    if [ "$arm" = base ]; then cp "$T/pristine-1756-pi.ts" "$PI"; cp "$T/pristine-1756-m.ts" "$M";
    else cp "$T/pristine-1756-pi-arm.ts" "$PI"; cp "$T/pristine-1756-m-arm.ts" "$M"; fi
    (cd "$R/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED core $arm"; continue; }
    (cd "$R/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED gql $arm"; continue; }
    # Code-level, both ways (items 1744/1749): countRangeAtMost exists only in the capped arm, and
    # a comment would be stripped so it cannot be the marker.
    got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
print('capped' if 'countRangeAtMost' in t else 'base')
")
    [ "$got" = "$arm" ] || { echo "ARM-ASSERT-FAILED $arm saw $got"; continue; }
    echo "arm-assert ok   $arm"
    #           the regression    the twin that must stay flat   selective seek (must stay fast)
    for s in rangewide rangelowcard range point band; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 600 env INDEXED=1 SHAPE="$s" N=400 node indexed-screen-probe.mjs 2>&1 | tail -1 | sed 's/.*"shape"/"shape"/;s/"indexed":true,//;s/,"sink".*//')
    done
  done
done
cp "$T/pristine-1756-pi-arm.ts" "$PI"; cp "$T/pristine-1756-m-arm.ts" "$M"
(cd "$R/packages/core" && bun run build > /dev/null 2>&1); (cd "$R/packages/gql" && bun run build > /dev/null 2>&1)
echo "left the ARM in place"
