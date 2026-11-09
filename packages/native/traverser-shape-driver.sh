#!/usr/bin/env bash
# Item 1746: unify the traverser's SHAPE across its three constructors.
#
# ⚠️ ITEM 1745 INTRODUCED A POLYMORPHISM AND DID NOT NOTICE. `extend` now sets `sack` as a plain
# field (5 fields) while `startTraverser` still omits it (4), so source traversers and extended ones
# have DIFFERENT hidden classes. Before 1745 the no-sack `extend` also produced 4, so they matched.
# 1745's measurements improved anyway -- the spread cost more than the new polymorphism -- but
# unifying should be better still, and it is the kind of thing a win can hide.
#
#   base   startTraverser 4 fields; incLoops `{ ...t, loopCount: t.loopCount + 1 }`
#   unified startTraverser sets `sack: undefined`; incLoops an explicit 5-field literal
#
# Equivalence is item 1745's, unchanged: `sack`'s only reader tests `=== undefined`, and nothing asks
# `'sack' in t` or enumerates a traverser's keys.
#
# `repeated` is in for `incLoops` (it is the only shape that reaches it); the rest are
# startTraverser-heavy at 20,000 source elements per rep.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gremlin/src/executor/runtime.ts
BASE=$R/crates/lenke-engine/target/pristine-1746-base.ts
D=$R/packages/gremlin/dist/esm/index.mjs

apply_arm() {
  cp "$BASE" "$S" || exit 90
  if [ "$1" = unified ]; then
    python3 - "$S" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()

st_old = """export const startTraverser = <T>(value: T, tracksPath = true): Traverser<T> => ({
  value,
  path: tracksPath ? [value] : NO_PATH,
  loopCount: 0,
  tags: emptyTags,
});"""
st_new = """export const startTraverser = <T>(value: T, tracksPath = true): Traverser<T> => ({
  value,
  path: tracksPath ? [value] : NO_PATH,
  loopCount: 0,
  tags: emptyTags,
  sack: undefined,
});"""
assert t.count(st_old) == 1, f"startTraverser anchor {t.count(st_old)}"
t = t.replace(st_old, st_new)

il_old = """export const incLoops = <T>(t: Traverser<T>): Traverser<T> => ({
  ...t,
  loopCount: t.loopCount + 1,
});"""
il_new = """export const incLoops = <T>(t: Traverser<T>): Traverser<T> => ({
  value: t.value,
  path: t.path,
  loopCount: t.loopCount + 1,
  tags: t.tags,
  sack: t.sack,
});"""
assert t.count(il_old) == 1, f"incLoops anchor {t.count(il_old)}"
t = t.replace(il_old, il_new)

open(p, 'w', encoding='utf-8').write(t)
PY
  fi
}

assert_dist() {
  local arm="$1" got
  # Checked BOTH ways: the unified arm adds `sack: void 0` to startTraverser AND removes incLoops'
  # spread, so require both signals to agree -- a half-applied edit reports HALF, not a number.
  got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
st = 'sack: void 0' in t or 'sack: undefined' in t
il = 'sack: t.sack' in t
if st and il: print('unified')
elif not st and not il: print('base')
else: print(f'HALF st={st} il={il}')
")
  if [ "$got" != "$arm" ]; then echo "ARM-ASSERT-FAILED $arm: saw [$got]"; return 1; fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base unified; do
    apply_arm "$arm"
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for shape in folded folded folded; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 900 node runtime-profile-gremlin-probe.mjs "$shape" 300 2>&1 | tail -1)
    done
  done
done
cp "$BASE" "$S"
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo "restored BASE"
