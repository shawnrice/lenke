#!/bin/zsh
# Item 2061 — the fused COUNT of the existence-filtered scan, LIVE against a KILLED gate.
#
# ⚠️ EVERY MEASUREMENT HAPPENS INSIDE THIS SCRIPT. `trap restore_live EXIT` restores and rebuilds on
# exit, so anything run AFTER invoking it measures LIVE whatever ROUND was asked for — that turned
# three of item 2059's follow-up runs into LIVE-vs-LIVE.
#
# ⚠️ REFRESH `PRISTINE` IF YOU EDIT `SRC` MID-ITEM. The start-of-run `cmp` cannot catch a stale
# snapshot, because the EXIT trap guarantees SRC == PRISTINE before every run — item 2059's complexity
# fix was silently reverted by this exact mechanism.
#
# ⚠️ WIDE CONTROLS: the rung hands its prefix to `nodeValuesWhereShortcut`, which serves a 16 ms row,
# and [[executor-edits-perturb]] prices that kind of neighbourhood at up to 16% on unrelated rows.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/index.ts
PRISTINE=$ROOT/crates/lenke-engine/target/gremlin-index.pristine.2061.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR="    scanWhereHasKeyCountResidual(effective, graph);"
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      sed -i "s@    scanWhereHasKeyCountResidual(effective, graph);@    undefined; // KILLED scanWhereHasKeyCountResidual@" "$SRC" || exit 1
      grep -cF "// KILLED scanWhereHasKeyCountResidual" "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  local IFS=$'\n'
  for row in ${=:-${ROWS:-"where: sub-traversal count
where: sub-traversal
where: sub-traversal order
where: neq filter
scan: values
scan: count"}}; do
    [[ -n "$row" ]] || continue
    (cd "$ROOT/packages/native" && NODES=200000 REPS=${REPS:-11} ONLY="=$row" MIXED=0 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -F "   $row" | tail -1)
  done
}

round "${ROUND:-}"
