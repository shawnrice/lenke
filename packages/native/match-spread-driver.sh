#!/usr/bin/env bash
# Item 1748: re-test a RECORDED REJECTION whose precondition changed.
#
# match.ts's header records: "`{ ...t, tags }` replaced by an explicit `{ value, path, loopCount,
# tags }` literal -- WORSE, 15858 / 17275 / 15885. The spread is not the problem and hand-writing
# the literal loses whatever shape the spread was preserving."
#
# ⚠️ THAT WAS MEASURED BEFORE ITEM 1746. The traverser had TWO shapes then (startTraverser 4 fields,
# extend 4), and 1746 unified all three constructors on 5 fields including `sack`. So "whatever
# shape the spread was preserving" may no longer differ from a hand-written literal -- and the old
# explicit literal omitted `sack` entirely, which under today's constructors would itself create the
# polymorphism 1746 removed. This is check-the-blocker-still-holds, not a re-derivation.
#
#   base      yield tagsObserved ? extend({ ...t, tags: new Map(tags) }, bindings) : extend(t, bindings)
#   explicit  the same with a 5-field literal carrying `sack`
#
# matchedsel has `select('c')` downstream so `tagsObserved` is TRUE and the spread arm runs.
# `matched` is `match(...).count()`, where tagsObserved is FALSE -- it never reaches the spread, so
# it is the CONTROL.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gremlin/src/executor/match.ts
BASE=$R/crates/lenke-engine/target/pristine-1748-base.ts
D=$R/packages/gremlin/dist/esm/index.mjs

apply_arm() {
  cp "$BASE" "$S" || exit 90
  if [ "$1" = explicit ]; then
    python3 - "$S" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = "      yield tagsObserved ? extend({ ...t, tags: new Map(tags) }, bindings) : extend(t, bindings);"
new = """      yield tagsObserved
        ? extend(
            {
              value: t.value,
              path: t.path,
              loopCount: t.loopCount,
              tags: new Map(tags),
              sack: t.sack,
            },
            bindings,
          )
        : extend(t, bindings);"""
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  local arm="$1" got
  # Position-implying and checked both ways: `loopCount: t.loopCount,` (no `+ 1`) exists only in the
  # explicit arm here; incLoops spells its own with `+ 1`.
  got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
# A COUNT, not a presence test. Two earlier detectors failed here: '...t,' occurs at other sites in
# the bundle (solve's own `{ ...t, tags: work }`, projection.ts's `{ ...t, tags }`), and
# 'loopCount: t.loopCount,' is ALREADY present twice in base. Item 1744's rule exactly.
n = t.count('loopCount: t.loopCount,')
print({2: 'base', 3: 'explicit'}.get(n, f'UNEXPECTED-{n}'))
")
  if [ "$got" != "$arm" ]; then echo "ARM-ASSERT-FAILED $arm: saw [$got]"; return 1; fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base explicit; do
    apply_arm "$arm"
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for s in matchedsel matchedsel matchedsel matched; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 900 node runtime-profile-gremlin-probe.mjs "$s" 10 2>&1 | tail -1)
    done
  done
done
cp "$BASE" "$S"
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo "restored BASE"
