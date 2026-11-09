#!/usr/bin/env bash
# Ablation driver for item 1733. One arm per build AND per process.
#
# Each arm asserts the DIST contains the arm's code before running: a build that silently failed
# leaves the previous arm in place, and the "after" reading is then the "before" code (CLAUDE.md).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/core/src/core/Vertex.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1733/Vertex.ts
DIST=$ROOT/packages/core/dist/esm/index.mjs

# anchor counts in the dist: base has 2 of each (Vertex + Edge); an arm drops ITS one to 1.
declare -A ANCHOR=(
  [base]="freeze(bag):2"
  [nofreeze]="freeze(bag):1"
  [nokeys]="keys = void 0:1"
  [nobox]="#box ?? :1"
)

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  case "$1" in
    base) : ;;
    nofreeze) sed -i 's/const frozen = Object\.freeze(bag);/const frozen = bag;/' "$SRC" || exit 91 ;;
    nokeys) sed -i '/^    box\.keys = undefined;$/d' "$SRC" || exit 92 ;;
    nobox) sed -i 's/this\.#box ?? this\.#graph\.elementProperties\.get(this\.#id)/this.#box/' "$SRC" || exit 93 ;;
    *) echo "unknown arm $1"; exit 94 ;;
  esac
}

assert_dist() {
  local arm="$1" spec="${ANCHOR[$1]}"
  local needle="${spec%:*}" want="${spec##*:}"
  local got
  got=$(python3 -c "
import sys
t=open('$DIST',encoding='utf-8',errors='replace').read()
print(t.count(sys.argv[1]))
" "$needle")
  if [ "$got" != "$want" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist count of [$needle] is $got, expected $want"
    return 1
  fi
  echo "arm-assert ok   $arm: [$needle] = $got"
  return 0
}

for round in 1 2 3; do
  for arm in base nofreeze nokeys nobox; do
    apply_arm "$arm"
    (cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    (cd "$ROOT/packages/native" && timeout 600 env ARM="$arm" node commit-ablate-probe.mjs 2>&1 | tail -1)
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
