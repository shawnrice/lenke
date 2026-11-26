#!/usr/bin/env bash
# Item 2411 — the ROUTE-TOGGLE A/B for `sum`/`avg` on the PATH-WALK rungs (`chain-projection.ts` and
# `hop2-projection.ts`), the shapes the chain LEVEL fold declines.
#
# The two arms differ in one expression PER FILE: `sumAgg` is computed (FOLDED) or forced to `null`
# (GENERIC, the tree as it stood before this item). The gate, the reducer and the bail are identical
# in both, so a difference is the ROUTE and nothing else.
#
# BOTH FILES MUST SWAP TOGETHER, which is why this script carries a file list rather than one
# `SRC`. The anchor is textually identical in the two modules — a swap that hit only one would leave
# the three-hop arms toggled and the two-hop arms not, and the readings would be a blend.
#
# WHY INTERLEAVED: a sequential before/after on item 2408 moved three arms the change could not reach
# by 1.44-1.73x — the machine drifts over minutes. Arms alternate order by round and the reported
# figure is the MIN OF THE PER-ROUND MEDIANS.
#
# ONE SHAPE PER PROCESS (CLAUDE.md's two-dist warning, item 762), and PER-ARM ASSERTION BEFORE ANY
# TIMING — item 2408 lost a whole run to an anchor that matched twice. Python does the counting and
# the swapping because the anchor is long and `grep -c` is line-based.
set -uo pipefail

SRCS=(
  "packages/gql/src/executor/chain-projection.ts"
  "packages/gql/src/executor/hop2-projection.ts"
)
ROUNDS="${ROUNDS:-3}"
MODS="${MODS:-labelexpr union neararg}"
SHAPES="${SHAPES:-sum countx rows}"

LIVE='const sumAgg = folded === undefined ? pathSumAggFor(proj, ret.projection.items[0]?.expr) : null;'
# THE GENERIC ARM KEEPS THE CALL REACHABLE behind `&& false` rather than deleting it: a bare
# `null` makes `pathSumAggFor` an unused import and the build's typecheck fails, which would read as
# a broken arm rather than a disabled one.
OFF='const sumAgg = folded === undefined && false ? pathSumAggFor(proj, ret.projection.items[0]?.expr) : null;'

cd "$(dirname "$0")/../.." || exit 1

swap() {
  python3 - "$1" "$2" "${SRCS[@]}" <<'PY'
import io, sys
old, new, paths = sys.argv[1], sys.argv[2], sys.argv[3:]
for p in paths:
    s = io.open(p, encoding='utf-8').read()
    n = s.count(old)
    if n != 1:
        print(f'ANCHOR NOT UNIQUE in {p}: {n} occurrences', file=sys.stderr)
        sys.exit(2)
for p in paths:
    s = io.open(p, encoding='utf-8').read()
    io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
}

# Total occurrences across BOTH files, so a half-applied swap reads as 1 and fails the assertion.
count_of() {
  python3 - "$1" "${SRCS[@]}" <<'PY'
import io, sys
needle, paths = sys.argv[1], sys.argv[2:]
print(sum(io.open(p, encoding='utf-8').read().count(needle) for p in paths))
PY
}

restore_live() {
  # A KILL BETWEEN THE SWAP AND THE SWAP BACK WOULD LEAVE THE TREE ON THE WRONG ARM — still
  # compiling, still green, feature silently OFF ([[ab-scripts-need-a-restore-trap]]).
  if [ "$(count_of "$OFF")" = "2" ]; then
    swap "$OFF" "$LIVE" && echo "restored LIVE arm"
  fi

  # AND IT MUST REBUILD. Restoring the SOURCE while leaving `packages/gql/dist` on whichever arm
  # was built last is worse than not restoring: the tree reads LIVE, `git diff` is empty, and every
  # later probe silently measures the OTHER arm ([[fuzzers-read-built-dists]]). That cost item 2409
  # four readings, each of which looked like the fold had stopped working.
  bun run build >/dev/null 2>&1 && echo "rebuilt dist on the LIVE arm"
}
trap restore_live EXIT INT TERM

if [ "$(count_of "$LIVE")" != "2" ]; then
  echo "REFUSING TO START: the tree is not on the LIVE arm (want 2 occurrences across both files)"
  exit 1
fi

run_arm() {
  local arm="$1"

  if [ "$arm" = GENERIC ]; then
    swap "$LIVE" "$OFF" || exit 2
  fi

  local n_live n_off
  n_live=$(count_of "$LIVE")
  n_off=$(count_of "$OFF")

  if [ "$arm" = FOLDED ] && { [ "$n_live" != 2 ] || [ "$n_off" != 0 ]; }; then
    echo "ARM ASSERTION FAILED: want FOLDED, live=$n_live off=$n_off"
    exit 3
  fi

  if [ "$arm" = GENERIC ] && { [ "$n_live" != 0 ] || [ "$n_off" != 2 ]; }; then
    echo "ARM ASSERTION FAILED: want GENERIC, live=$n_live off=$n_off"
    exit 3
  fi

  bun run build >/dev/null 2>&1 || { echo "BUILD FAILED on $arm"; exit 4; }

  for m in $MODS; do
    for s in $SHAPES; do
      printf '  %-8s %-10s %-7s ' "$arm" "$m" "$s"
      (cd packages/native && timeout 600 systemd-run --user --scope -q \
        -p MemoryMax=16G -p MemorySwapMax=0 \
        env MOD="$m" SHAPE="$s" NODES="${NODES:-20000}" FANOUT="${FANOUT:-4}" \
        HOPS="${HOPS:-3}" \
        bun chainagg-modifier-2410.ts 2>&1 | head -1 | sed 's/.*median //; s/  answer.*//')
    done
  done

  if [ "$arm" = GENERIC ]; then
    swap "$OFF" "$LIVE" || exit 2
  fi
}

for r in $(seq 1 "$ROUNDS"); do
  echo "=== round $r ==="

  # ORDER ALTERNATES: whichever arm runs first pays for a cold page cache and a cooler CPU.
  if [ $((r % 2)) -eq 1 ]; then
    run_arm GENERIC
    run_arm FOLDED
  else
    run_arm FOLDED
    run_arm GENERIC
  fi
done

echo "=== done; tree left on: $([ "$(count_of "$LIVE")" = 2 ] && echo LIVE || echo '*** NOT LIVE ***') ==="
