#!/usr/bin/env bash
# Item 1758: the Gremlin twin of item 1756's capped range count.
set -u
R=/home/shawn/projects/pl-graph
T=$R/crates/lenke-engine/target
S=$R/packages/gremlin/src/executor/index-seed.ts
D=$R/packages/gremlin/dist/esm/index.mjs
for round in 1 2 3; do
  for arm in base capped; do
    if [ "$arm" = base ]; then cp "$T/pristine-1758-base.ts" "$S"; else cp "$T/pristine-1758-arm.ts" "$S"; fi
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    # Code-level, both ways: rangeCap exists only in the capped arm (a comment would be stripped).
    got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
print('capped' if 'rangeCap' in t else 'base')
")
    [ "$got" = "$arm" ] || { echo "ARM-ASSERT-FAILED $arm saw $got"; continue; }
    echo "arm-assert ok   $arm"
    for s in rangewide rangelowcard rangetight; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 600 env INDEXED=1 SHAPE="$s" node gremlin-range-count-probe.mjs 2>&1 | tail -1 | sed 's/"indexed":true,//;s/.*"shape"/"shape"/;s/"n":300,//')
    done
  done
done
cp "$T/pristine-1758-arm.ts" "$S"
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo "left the ARM in place"
