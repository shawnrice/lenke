#!/usr/bin/env bash
# Item 1740: what would hoisting the property BAG per row be worth?
#
# `propOf(bound, key)` is `bound?.properties?.[key] ?? null`, so it calls the `properties` GETTER on
# every read. A multi-column RETURN calls it once per column on the SAME element -- `wideproj`
# (RETURN n.k, n.n, n.s, n.k, n.n) makes FIVE getter calls per row where one would do. Item 1738
# priced a single read at ~22 ns including the call, so four redundant ones is ~80 ns a row.
#
#   base  as shipped
#   memo  ⚠️ CEILING ONLY, AND KNOWINGLY UNSAFE: a module-level one-entry memo keyed on the bound
#         object's IDENTITY. It is NOT a shipping candidate -- a write REPLACES an element's bag
#         without changing the element object, so `MATCH (n) SET n.x = 1 RETURN n.x` would read a
#         stale bag. It exists to answer "is the redundancy worth plumbing for?" before any design.
#
# A safe version would hoist the bag inside the projection's own row scope, where no write can
# intervene. That is only worth building if this ceiling is large.
#
# ⚠️ CONTROLS: `hoprows` and `distincthi` read ONE property per row, so they cannot gain from
# removing redundancy -- they can only lose the memo's extra branch. If they gain, the reading is
# not about redundancy.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1740/values.ts
DIST=$ROOT/packages/gql/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  if [ "$1" = memo ]; then
    python3 - "$SRC" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = """export const propOf = (bound: unknown, key: string): unknown =>
  (bound as { properties?: Record<string, unknown> } | undefined)?.properties?.[key] ?? null;"""
new = """let ablateLastBound: unknown;
let ablateLastBag: Record<string, unknown> | undefined;

export const propOf = (bound: unknown, key: string): unknown => {
  if (bound !== ablateLastBound) {
    ablateLastBound = bound;
    ablateLastBag = (bound as { properties?: Record<string, unknown> } | undefined)?.properties;
  }

  return ablateLastBag?.[key] ?? null;
};"""
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  # Position-implying and checked BOTH ways (items 1737/1738): the memo's own identity test can only
  # exist if the replacement landed, and the original one-liner's shape can only survive if it did not.
  local arm="$1" got
  got=$(python3 -c "
t=open('$DIST',encoding='utf-8',errors='replace').read()
added = 'ablateLastBound' in t
print('memo' if added else 'base')
")
  if [ "$got" != "$arm" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist shape is [$got], expected [$arm]"
    return 1
  fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base memo; do
    apply_arm "$arm"
    (cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    #            5 reads/row   1 read/row (controls)
    for shape in wideproj hoprows distincthi; do
      printf '%s ' "$arm"
      (cd "$ROOT/packages/native" && timeout 900 node runtime-profile-probe.mjs "$shape" 300 2>&1 | tail -1)
    done
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
