#!/usr/bin/env bash
# Item 1741: hoist the property BAG once per row in nodeProjection's direct-read loop.
#
# The loop is `row[cols[i]] = dk === undefined ? fns[i](env) : propOf(v, dk)`, and `propOf` is
# `v?.properties?.[key] ?? null` -- so a five-column RETURN off one element calls the `properties`
# GETTER five times per row. The hoist resolves it once:
#
#   base   propOf(v, dk)                       per column
#   hoist  const bag = v.properties  (once)    then bag?.[dk] ?? null  per column
#
# EXACTLY EQUIVALENT, and that is why this one needs no owner decision: it is the same getter on the
# same element, and nothing in a projection expression can write, so the bag cannot change between
# two columns of one row. Same values, same order, byte-identical.
#
# ⚠️ n=1500, NOT 300. Item 1740 established this shape spreads 18% at 300 runs and 1.3% at 1500 once
# the warm-up run is dropped. At 300 it cannot resolve the effect at all, and that item measured
# nothing partly for this reason.
#
# ⚠️ CONTROLS. `narrow1` reads ONE property per row on the SAME rung, so it cannot gain from removing
# a repeated read and can only lose the hoist's extra local -- it must stay flat. `hoprows` takes a
# DIFFERENT rung (hopProjection) and must not move at all.
#
# ⚠️ item 1512, recorded ten lines above the loop being changed, hoisted the env object out of this
# very loop and measured FLAT (1.01x). So a plausible hoist here has already failed once.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/node-scan.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1741/node-scan.ts
DIST=$ROOT/packages/gql/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  if [ "$1" = hoist ]; then
    python3 - "$SRC" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = """      const row: Row = {};

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i]({ binding, params, graph }) : propOf(v, dk);
      }"""
new = """      const row: Row = {};
      const bag = hoistBag ? v.properties : undefined;

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] =
          dk === undefined
            ? fns[i]({ binding, params, graph })
            : hoistBag
              ? (bag?.[dk] ?? null)
              : propOf(v, dk);
      }"""
decl = "  const cstart = cm.patterns[0].start;"
assert t.count(decl) == 1, f"decl anchor matched {t.count(decl)} times"
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
t = t.replace(decl, "  const hoistBag = directKeys.filter((k) => k !== undefined).length > 1;\n" + decl)
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  # Position-implying, checked BOTH ways (items 1737/1738): the hoisted local can only exist if the
  # replacement landed in THAT loop, and the original call can only survive if it did not.
  local arm="$1" got
  got=$(python3 -c "
t=open('$DIST',encoding='utf-8',errors='replace').read()
added = 'hoistBag' in t
print('hoist' if added else 'base')
")
  if [ "$got" != "$arm" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist shape is [$got], expected [$arm]"
    return 1
  fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base hoist; do
    apply_arm "$arm"
    (cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for shape in wideproj wide2 narrow1; do
      printf '%s ' "$arm"
      (cd "$ROOT/packages/native" && timeout 900 node runtime-profile-probe.mjs "$shape" 1500 2>&1 | tail -1)
    done
    printf '%s ' "$arm"
    (cd "$ROOT/packages/native" && timeout 900 node runtime-profile-probe.mjs hoprows 600 2>&1 | tail -1)
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
