#!/bin/zsh
# Item 2059 — the unindexed `V().has(k,pred).values(key)` scan, LIVE against a KILLED gate.
#
# ⚠️ THE KILL SWITCH IS THE CALL SITE, NOT THE RUNG. Killing the rung's gate would leave the chain
# calling a function that always declines; killing the call site is what the pipeline actually did
# before this item, so the KILLED arm is the real baseline.
#
# ⚠️ WIDE CONTROLS, because [[executor-edits-perturb]] prices a new walk variant at up to 16% on
# UNRELATED rows. The new walk is module-scope and nothing existing was edited, so the prediction is
# flat controls — but that is the claim under test, not an assumption.
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE (LIVE/KILLED), not PRE/POST (item 2023), and RESTORE REBUILDS
# (item 2031: a restored SOURCE with a stale DIST measures the experiment under the control's name).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/index.ts
PRISTINE=$ROOT/crates/lenke-engine/target/gremlin-index.pristine.2059.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

# ⚠️⚠️ **A SNAPSHOT TAKEN EARLY AND AN EDIT MADE LATER IS A SILENT REVERT.** This check passes
# whenever SRC == PRISTINE, and since the EXIT trap restores SRC from PRISTINE after every run, it
# passes trivially even when PRISTINE is stale relative to the source you MEANT to have. That is not
# hypothetical: a later complexity fix to `index.ts` was reverted by this script's own restore, the
# lint gate went red again, and one A/B round measured a mixed tree. **Refresh PRISTINE whenever you
# edit SRC**, and the anchor check below is what would catch a snapshot missing the feature entirely.
cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR="    : (seededNodeValuesShortcut(effective, graph) ?? unindexedHasValuesShortcut(effective, graph));"
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED)
      cp "$PRISTINE" "$SRC" || exit 1
      # `x ?? undefined` is the call site with the rung removed — valid TS, one line, unique anchor.
      # ⚠️ ONE LINE, because `bun run fmt` collapses the two-line `??` — an anchor written against
      # the pre-format shape found 0 matches and the script refused, which is the behaviour wanted.
      sed -i "s@?? unindexedHasValuesShortcut(effective, graph)@?? undefined); // KILLED unindexedHasValuesShortcut (@" "$SRC" || exit 1
      grep -cF "// KILLED unindexedHasValuesShortcut" "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # THE TARGETS: the equality and range forms, one arm per PROCESS (item 2058's whole lesson).
  #
  # ⚠️⚠️ **EVERY MEASUREMENT MUST HAPPEN IN HERE.** `trap restore_live EXIT` restores the LIVE source
  # and REBUILDS when this script exits, so a measurement run AFTER invoking it measures LIVE no
  # matter which ROUND was asked for. That silently turned three follow-up runs into LIVE-vs-LIVE and
  # produced a "the controls are flat" reading that meant nothing. `ARMS`/`ROWS`/`REPS` are env knobs
  # so a focused re-measurement stays inside the arm it names.
  for a in ${=ARMS:-B D}; do
    (cd "$ROOT/packages/native" && NODES=200000 REPS=${REPS:-9} ARM=$a timeout 900 bun predicate-kind-2058.mjs 2>&1 | grep -E "^  $a ")
  done

  # ⚠️ `point: has(k,v)` IS A TARGET, NOT A CONTROL — it is `V().has('k',7).values('n')`, exactly this
  # rung's shape, and the first run of this script mislabelled it. `label: has values` is FOUR steps
  # so the rung declines it (item 1870's refusal). The real controls are the two plain scans and the
  # count.
  local IFS=$'\n'
  for row in ${=:-${ROWS:-"scan: values
scan: id
label: has values
scan: count"}}; do
    [[ -n "$row" ]] || continue
    (cd "$ROOT/packages/native" && NODES=200000 REPS=${REPS:-9} ONLY="$row" MIXED=0 timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -F "$row")
  done
}

round "${ROUND:-}"
