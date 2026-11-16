#!/bin/zsh
# Item 2040 — the CSR start-label arm, LIVE against a KILLED gate.
#
# ⚠️ THE KILL SWITCH RAISES THE COVERAGE THRESHOLD ABOVE 1, which makes the arm unreachable for ANY
# graph while leaving every line of it compiled and type-checked. That is the form
# `EDGE_DRIVEN_MIN_COVERAGE` records for its own A/B, and it is better than commenting the call out:
# nothing else in the gate changes shape.
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE (LIVE/KILLED), not PRE/POST (item 2023).
# ⚠️ RESTORE REBUILDS — `@lenke/*` resolve to dist, so a restored SOURCE with a stale BUILD measures
# the experiment under the control's name (item 2031 did exactly that).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/hop-values-csr.ts
PRISTINE=$ROOT/crates/lenke-engine/target/hop-values-csr.pristine.2040ab.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR='const CSR_START_LABEL_MIN_COVERAGE = 0.1;'
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      sed -i "s@const CSR_START_LABEL_MIN_COVERAGE = 0.1;@const CSR_START_LABEL_MIN_COVERAGE = 2;@" "$SRC" || exit 1
      grep -cF 'MIN_COVERAGE = 2;' "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # The nominated shape on its own fixture, both label modes. MIXED=0 is a CONTROL: the label is
  # vacuous there, `dropVacuousLabels` deletes the step, and this arm is never consulted.
  for m in 0 1; do
    (cd "$ROOT/packages/native" && MIXED=$m NODES=20000 FANOUT=5 timeout 900 bun runtime-profile-gremlin-probe.mjs labelhop 60 2>&1 | tail -1)
    # ⚠️ THE LABEL-FREE FLOOR is the second control — no label step at all, so no gate can reach it.
    (cd "$ROOT/packages/native" && MIXED=$m NODES=20000 FANOUT=5 timeout 900 bun runtime-profile-gremlin-probe.mjs labelhopfloor 60 2>&1 | tail -1)
  done

  # ⚠️ AND THE WIDE SCREEN, because an executor edit costs UNRELATED rows up to 16%
  # ([[executor-edits-perturb]]) and this one is inside the hottest walk in the engine.
  (cd "$ROOT/packages/native" && MIXED=1 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -E "^    [0-9]")
}

round "${ROUND:-}"
