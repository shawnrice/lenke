#!/usr/bin/env bash
# Item 1736: copyProps' no-keys arm, the Object.keys loop vs Object.assign.
#
# The mutation is an exact multi-line string replacement done in python with an asserted match
# count, which is stricter than a line-wise sed: a loop body that had drifted would fail to match
# rather than being partially rewritten.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/projection.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1736/projection.ts
DIST=$ROOT/packages/gremlin/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  if [ "$1" = assign ]; then
    python3 - "$SRC" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = """  for (const k of Object.keys(props)) {
    out[k] = props[k];
  }
"""
new = """  Object.assign(out, props);
"""
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  local want=0
  [ "$1" = assign ] && want=1
  local got
  got=$(python3 -c "
t=open('$DIST',encoding='utf-8',errors='replace').read()
print(t.count('Object.assign(out, props)'))
")
  if [ "$got" != "$want" ]; then
    echo "ARM-ASSERT-FAILED $1: dist count of Object.assign(out, props) = $got, expected $want"
    return 1
  fi
  echo "arm-assert ok   $1: Object.assign(out, props) = $got"
  return 0
}

for round in 1 2 3; do
  for arm in base assign; do
    apply_arm "$arm"
    (cd "$ROOT/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue

    for w in 3 8 24; do
      (cd "$ROOT/packages/native" && timeout 600 env ARM="$arm" WIDTH="$w" SHAPE=valuemap node valuemap-copy-probe.mjs 2>&1 | tail -1)
    done
    # the control never calls copyProps and must not move
    (cd "$ROOT/packages/native" && timeout 600 env ARM="$arm" WIDTH=3 SHAPE=values node valuemap-copy-probe.mjs 2>&1 | tail -1)
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/gremlin" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
