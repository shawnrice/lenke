#!/bin/zsh
# Item 2042 — a trailing terminal riding the label-seeded fusion, LIVE against the OLD gate.
#
# ⚠️ THE KILLED ARM RESTORES ITEM 2037's EXACT CONDITION (`steps.length === 0` -> `!== 1`), which is
# the one line this item changed. That is better than disabling the whole rung: the PRE arm is then
# the shipped behaviour of four items ago, not "no fusion at all".
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE (LIVE/KILLED), not PRE/POST (item 2023).
# ⚠️ RESTORE REBUILDS — `@lenke/*` resolve to dist, so a restored SOURCE with a stale BUILD measures
# the experiment under the control's name (item 2031 did exactly that).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/node-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/node-values.pristine.2042.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR='  if (tracksPath || steps.length === 0) {'
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      sed -i "s@if (tracksPath || steps.length === 0) {@if (tracksPath || steps.length !== 1) {@" "$SRC" || exit 1
      grep -cF 'if (tracksPath || steps.length !== 1) {' "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # The target plus three controls: the label-free floor (no step for the gate to lose), the
  # item-2037 shape (an EMPTY residual, which this item did not touch), and item 2040's hop arm.
  for s in labelorder labelorderfloor labelhop; do
    for m in 0 1; do
      (cd "$ROOT/packages/native" && MIXED=$m NODES=20000 FANOUT=5 timeout 900 bun runtime-profile-gremlin-probe.mjs "$s" 60 2>&1 | tail -1)
    done
  done

  # ⚠️ AND THE WIDE SCREEN ([[executor-edits-perturb]]).
  (cd "$ROOT/packages/native" && MIXED=1 NODES=100000 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -E "^    [0-9]")
}

round "${ROUND:-}"
