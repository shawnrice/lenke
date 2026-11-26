#!/bin/zsh
# Item 2028 — the `count` terminal admitted in three more rungs, PRE/POST.
#
# THREE FILES CHANGE, so the arms are whole-file swaps against `HEAD` rather than a sed: the same
# one-line gate now appears in four rungs (the `optional` one from item 2027 included), so a line
# anchor would hit all of them and the verdict would cover four decisions at once — item 2020's
# lesson about an over-broad mutant, applied to an A/B arm.
#
# ARMS NAMED FOR WHAT THEY ARE (`HEAD` / `FUSED`), not PRE/POST — item 2023, where PRE/POST put the
# experiment under the "PRE" label and nearly inverted the conclusion.
#
# ONE ARM PER PROCESS (item 762): this change redistributes call sites, which item 762 prices at up
# to 1.56x in such a change's favour on a shared dispatch site.
#
# RESTORE ON ANY EXIT, and the FUSED arm is the working tree, so a kill mid-round must put the
# working files back — `git checkout` is forbidden here, so the pristine copies are taken by hand.
set -u

ROOT=/home/shawn/projects/pl-graph
G=$ROOT/packages/gremlin/src/executor
SCRATCH=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad
FILES=(choose-hop-values.ts branch-value-hop.ts coalesce-hop-values.ts)
ARMS=(chooseCount branchCount coalesceCount chooseTwoArm branchTwo coalesceTwoHops optional hop)

mkdir -p "$SCRATCH/ab2028/head" "$SCRATCH/ab2028/fused" || exit 1

# Snapshot both arms ONCE, so each round is a byte-exact copy rather than a re-derivation.
for f in "${FILES[@]}"; do
  if [[ ! -f "$SCRATCH/ab2028/fused/$f" ]]; then
    cp "$G/$f" "$SCRATCH/ab2028/fused/$f" || exit 1
    (cd "$ROOT" && git show "HEAD:packages/gremlin/src/executor/$f") > "$SCRATCH/ab2028/head/$f" || exit 1
  fi
done

restore_fused() {
  for f in "${FILES[@]}"; do
    cp "$SCRATCH/ab2028/fused/$f" "$G/$f" || print -- "[trap] COULD NOT RESTORE $f"
  done
}
trap restore_fused EXIT INT TERM

round() {
  for f in "${FILES[@]}"; do
    cp "$SCRATCH/ab2028/$2/$f" "$G/$f" || exit 1
    # ASSERT THE ARM IS THE CODE IT CLAIMS — CLAUDE.md's rule.
    cmp -s "$G/$f" "$SCRATCH/ab2028/$2/$f" || { print -- "ARM NOT SET: $1 ($f)"; exit 1; }
  done

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="
  for arm in "${ARMS[@]}"; do
    (cd "$ROOT/packages/native" && ARM=$arm timeout 900 bun coalesce-vs-optional-1990.mjs 2>&1 | tail -1)
  done
}

case "${ROUND:-}" in
  HEAD) round HEAD head ;;
  FUSED) round FUSED fused ;;
  *) print -- "set ROUND=HEAD | FUSED"; exit 1 ;;
esac
