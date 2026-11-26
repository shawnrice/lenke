#!/usr/bin/env bash
# Item 2409 — the ROUTE-TOGGLE A/B for the multiplicity-weighted `sum`/`avg` on the chain level fold.
#
# The two arms differ in ONE LINE: `WEIGHTED` holding {sum, avg} (FOLDED) or holding nothing
# (GENERIC, which is the tree as it stood before this item). Everything else — the gate, the fold,
# the bail — is identical in both, so a difference is the ROUTE and nothing else.
#
# WHY INTERLEAVED, AND IT IS NOT OPTIONAL HERE. A sequential before/after on item 2408 moved three
# arms the change could not reach by 1.44-1.73x, which is CLAUDE.md's named giveaway: the machine
# drifts over minutes and a reading taken minutes apart measures the drift. Arms alternate order by
# round and the reported figure is the MIN OF THE PER-ROUND MEDIANS.
#
# ONE SHAPE PER PROCESS, so no other query shape pollutes the dispatch site's inline caches
# (CLAUDE.md's two-dist warning, item 762).
#
# PER-ARM ASSERTION BEFORE ANY TIMING. Item 2408 lost a whole run to an anchor that matched twice;
# the assertion caught it. Python does the counting and the swapping because the anchors are
# multi-line and `grep -c` is line-based, which makes every line-wise count 0 and every assertion
# vacuous.
set -uo pipefail

SRC="packages/gql/src/executor/chain-fold-levels.ts"
ROUNDS="${ROUNDS:-3}"
SHAPES="${SHAPES:-sum avg min countx rows bare}"

LIVE='const WEIGHTED: ReadonlySet<string> = new Set(['"'"'sum'"'"', '"'"'avg'"'"']);'
OFF='const WEIGHTED: ReadonlySet<string> = new Set([]);'

cd "$(dirname "$0")/../.." || exit 1

swap() {
  python3 - "$SRC" "$1" "$2" <<'PY'
import io, sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
n = s.count(old)
if n != 1:
    print(f'ANCHOR NOT UNIQUE: {n} occurrences of {old[:60]!r}', file=sys.stderr)
    sys.exit(2)
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
}

count_of() {
  python3 - "$SRC" "$1" <<'PY'
import io, sys
print(io.open(sys.argv[1], encoding='utf-8').read().count(sys.argv[2]))
PY
}

restore_live() {
  # A KILL BETWEEN THE SWAP AND THE SWAP BACK WOULD LEAVE THE TREE ON THE WRONG ARM — still
  # compiling, still green, and with the feature silently OFF ([[ab-scripts-need-a-restore-trap]]).
  if [ "$(count_of "$OFF")" = "1" ]; then
    swap "$OFF" "$LIVE" && echo "restored LIVE arm"
  fi

  # AND IT MUST REBUILD, WHICH THE FIRST VERSION OF THIS SCRIPT DID NOT. Restoring the SOURCE
  # while leaving `packages/gql/dist` on whichever arm was built last is worse than not restoring:
  # the tree reads LIVE, `git diff` is empty, and every later probe silently measures the OTHER arm
  # ([[fuzzers-read-built-dists]] — `@lenke/*` resolve to dist). It cost four readings here, each of
  # which looked like the fold had stopped working.
  bun run build >/dev/null 2>&1 && echo "rebuilt dist on the LIVE arm"
}
trap restore_live EXIT INT TERM

# START-OF-RUN CHECK: the tree must begin on the LIVE arm, or a previous interrupted run left it OFF
# and every "FOLDED" reading below would silently be a GENERIC one.
if [ "$(count_of "$LIVE")" != "1" ]; then
  echo "REFUSING TO START: the tree is not on the LIVE arm (expected 1 occurrence of the live line)"
  exit 1
fi

run_arm() {
  local arm="$1"

  if [ "$arm" = GENERIC ]; then
    swap "$LIVE" "$OFF" || exit 2
  fi

  # ASSERT THE ARM IS THE CODE IT CLAIMS, before building it.
  local want_live want_off
  want_live=$(count_of "$LIVE")
  want_off=$(count_of "$OFF")

  if [ "$arm" = FOLDED ] && { [ "$want_live" != 1 ] || [ "$want_off" != 0 ]; }; then
    echo "ARM ASSERTION FAILED: want FOLDED, live=$want_live off=$want_off"
    exit 3
  fi

  if [ "$arm" = GENERIC ] && { [ "$want_live" != 0 ] || [ "$want_off" != 1 ]; }; then
    echo "ARM ASSERTION FAILED: want GENERIC, live=$want_live off=$want_off"
    exit 3
  fi

  bun run build >/dev/null 2>&1 || { echo "BUILD FAILED on $arm"; exit 4; }

  for s in $SHAPES; do
    printf '  %-8s %-7s ' "$arm" "$s"
    (cd packages/native && timeout 600 systemd-run --user --scope -q \
      -p MemoryMax=16G -p MemorySwapMax=0 \
      env SHAPE="$s" NODES="${NODES:-20000}" FANOUT="${FANOUT:-4}" HOPS="${HOPS:-3}" \
      bun chainagg-2409.ts 2>&1 | head -1 | sed 's/.*median //; s/  answer.*//')
  done

  if [ "$arm" = GENERIC ]; then
    swap "$OFF" "$LIVE" || exit 2
  fi
}

for r in $(seq 1 "$ROUNDS"); do
  echo "=== round $r ==="

  # ORDER ALTERNATES. Whichever arm runs first pays for a cold page cache and a cooler CPU, so a
  # fixed order charges one arm for it every round.
  if [ $((r % 2)) -eq 1 ]; then
    run_arm GENERIC
    run_arm FOLDED
  else
    run_arm FOLDED
    run_arm GENERIC
  fi
done

echo "=== done; tree left on: $([ "$(count_of "$LIVE")" = 1 ] && echo LIVE || echo '*** NOT LIVE ***') ==="
