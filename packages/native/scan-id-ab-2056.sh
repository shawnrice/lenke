#!/bin/zsh
# Item 2056 — the scan rung's `id()` arm, LIVE against a KILLED gate.
#
# THE CONTROL IS THE POINT. `scan: values` already rode this rung, and the change added a SECOND
# closure beside its loop; the walk is selected once, not per row, so it should be free — but this
# file's own record is that "a branch in that inner loop" cost 1.6x (item 159), and `scan: values`
# read 4.42 before the change and 5.69 after in single runs. Alternated rounds settle whether that is
# the change or the row.
#
# THE KILL SWITCH removes only the `id` clause from `matchShape`, so the KILLED arm is exactly the
# rung as it shipped before this item — not "no rung at all".
#
# ARMS NAMED FOR WHAT THEY ARE (LIVE/KILLED), not PRE/POST (item 2023), and RESTORE REBUILDS
# (item 2031: a restored SOURCE with a stale DIST measures the experiment under the control's name).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/node-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/node-values.pristine.2056.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR="  if (steps.length === 2 && second?.kind === 'id') {"
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      sed -i "s@if (steps.length === 2 \&\& second?.kind === 'id') {@if (false \&\& second?.kind === 'id') {@" "$SRC" || exit 1
      grep -cF "if (false && second?.kind === 'id') {" "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # The target plus three controls: the `values` arm that shares the rung, the labelled `values` arm
  # (a different gate), and a count the rung cannot reach.
  for row in "scan: id" "scan: values" "label: values" "scan: count"; do
    (cd "$ROOT/packages/native" && NODES=200000 REPS=9 ONLY="$row" MIXED=0 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -F "$row")
  done
}

round "${ROUND:-}"
