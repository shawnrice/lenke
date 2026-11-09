#!/usr/bin/env bash
# Item 1734: base (bags frozen) vs nofreeze (bags not frozen), READ shapes only.
#
# Same restore -> mutate -> build -> assert-the-dist pattern as commit-ablate-driver.sh. The freeze
# is ablated in BOTH Vertex.ts and Edge.ts here, because a read probe must not leave one element
# type frozen and the other not.
set -u

ROOT=/home/shawn/projects/pl-graph
PDIR=$ROOT/crates/lenke-engine/target/pristine-1733
DIST=$ROOT/packages/core/dist/esm/index.mjs

count_in_dist() {
  python3 -c "
import sys
t=open('$DIST',encoding='utf-8',errors='replace').read()
print(t.count(sys.argv[1]))
" "$1"
}

for round in 1 2; do
  for arm in base nofreeze; do
    cp "$PDIR/Vertex.ts" "$ROOT/packages/core/src/core/Vertex.ts" || exit 90
    cp "$PDIR/Edge.ts" "$ROOT/packages/core/src/core/Edge.ts" || exit 90

    want=2
    if [ "$arm" = nofreeze ]; then
      sed -i 's/const frozen = Object\.freeze(bag);/const frozen = bag;/' \
        "$ROOT/packages/core/src/core/Vertex.ts" "$ROOT/packages/core/src/core/Edge.ts" || exit 91
      want=0
    fi

    (cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }

    got=$(count_in_dist 'freeze(bag)')
    if [ "$got" != "$want" ]; then
      echo "ARM-ASSERT-FAILED $arm: dist freeze(bag) = $got, expected $want"
      continue
    fi
    echo "arm-assert ok   $arm: freeze(bag) = $got"

    for shape in raw keys gql; do
      (cd "$ROOT/packages/native" && timeout 600 env ARM="$arm" SHAPE="$shape" node frozen-read-probe.mjs 2>&1 | tail -1)
    done
  done
done

cp "$PDIR/Vertex.ts" "$ROOT/packages/core/src/core/Vertex.ts"
cp "$PDIR/Edge.ts" "$ROOT/packages/core/src/core/Edge.ts"
(cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
