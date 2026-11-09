#!/usr/bin/env bash
# Item 1739: valueSet.add's primitive branch -- two Set operations, or one plus a size delta?
#
#   base       if (prim.has(v)) return false; prim.add(v); return true;
#   sizedelta  const before = prim.size; prim.add(v); return prim.size !== before;
#
# EXACTLY EQUIVALENT, which is why this one needs no owner decision: both forms key the Set itself,
# so both use SameValueZero and agree on NaN, on -0 against 0, and on every other value. The only
# difference is the number of HASH operations: base costs one for a duplicate and two for a new
# value; sizedelta costs one always, plus two integer field reads.
#
# So the lever only pays when values are NEW, and item 1738 nearly dismissed it by measuring the one
# shape where they are not: distinct is i % 97 over 20,000 rows, where almost every add is a
# duplicate. Three cardinality tiers here, with the low one as the control that must NOT move.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/shortcuts.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1739/shortcuts.ts
DIST=$ROOT/packages/gql/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  if [ "$1" = sizedelta ]; then
    python3 - "$SRC" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = """      if (v === null || typeof v !== 'object') {
        if (prim.has(v)) {
          return false;
        }

        prim.add(v);

        return true;
      }"""
new = """      if (v === null || typeof v !== 'object') {
        const ablateBefore = prim.size;

        prim.add(v);

        return prim.size !== ablateBefore;
      }"""
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  # Position-implying anchor (item 1738): ablateBefore can only exist if the replacement landed in
  # that branch, and prim.has can only survive if it did not. Checking BOTH directions, so a
  # half-applied edit fails rather than passing on the symbol's mere presence.
  local arm="$1" got
  got=$(python3 -c "
t=open('$DIST',encoding='utf-8',errors='replace').read()
added = 'ablateBefore' in t
removed = 'prim.has(' not in t
print('sizedelta' if (added and removed) else 'base' if (not added and not removed) else 'HALF-APPLIED')
")
  if [ "$got" != "$arm" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist shape is [$got], expected [$arm]"
    return 1
  fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base sizedelta; do
    apply_arm "$arm"
    (cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    #                 20,000 distinct   1,000 distinct   97 distinct (the control)
    for shape in distincthi distinctstr distinct; do
      printf '%s ' "$arm"
      # ⚠️ The probe throws on an empty result, and tail -1 would bank a CRASH's last line as a
      # measurement (item 1738). Keeping stderr means a failure is visible as a stack, not a number.
      (cd "$ROOT/packages/native" && timeout 900 node runtime-profile-probe.mjs "$shape" 500 2>&1 | tail -1)
    done
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
