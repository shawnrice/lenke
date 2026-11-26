#!/bin/zsh
# Item 2070 — the BARE TRAILING `aggregate` barrier arm, LIVE against a KILLED gate.
#
# `store` IS A CONTROL HERE, NOT A TARGET: it is lazy by contract and must stay on the generic path,
# so its row moving would be a DEFECT, not a win.
#
# The drain-vs-iterate A/B (this script's first form) split in opposite directions across rows, so the
# fix is a per-walk tight-loop count rather than a flip. KILLED removes only that new branch, leaving
# the two-arm function exactly as it shipped.
#
# THE DIRECTION IS GENUINELY OPEN, which is why this is an A/B and not a fix. With a `drain` the
# function builds the whole array to read `.length` — item 2061 measured 1.88x sitting there — but item
# 1998 measured a walk WITHOUT a drain at 1.55x, so a generator's per-yield cost can lose to a tight
# drain loop even though the drain allocates.
#
# THE BLAST RADIUS IS THREE ROWS, measured not assumed. `countwalk-census-2062.mjs` patched the
# function and counted calls per shape: of 14 count-bearing shapes only `scan: where values count`,
# `edgef: outE has count` and `edgef: outE has inV count` arrive here at all; the other nine
# (`scan: count`, `hop1/hop2: count`, `… has count`, `… dedupe count`, `… values count`) reach it ZERO
# times and are answered elsewhere. I had claimed at item 2061 that this was "shared by every count
# fusion" — the census refutes that.
#
# EVERY MEASUREMENT HAPPENS INSIDE THIS SCRIPT (the EXIT trap rebuilds LIVE), and `PRISTINE` must be
# refreshed if `SRC` is edited mid-item — both hazards cost item 2059 a re-measurement.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/index.ts
PRISTINE=$ROOT/crates/lenke-engine/target/gremlin-index.pristine.2070.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR="  if (fusableProjectedBarrier(projected.rest)) {"
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      sed -i "s@  if (fusableProjectedBarrier(projected.rest)) {@  if (false \&\& fusableProjectedBarrier(projected.rest)) { // KILLED 2070@" "$SRC" || exit 1
      grep -cF "// KILLED 2070" "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # EXACT ROW NAMES (`ONLY='=…'`, added at item 2061): `ONLY=` is a substring match and five row
  # names are prefixes of others, which silently runs several shapes in one process.
  local IFS=$'\n'
  for row in ${=ROWS}; do
    [[ -n "$row" ]] || continue
    (cd "$ROOT/packages/native" && NODES=200000 REPS=${REPS:-11} ONLY="=$row" MIXED=0 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -F "   $row" | tail -1)
  done
}

round "${ROUND:-}"
