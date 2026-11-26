#!/bin/zsh
# Item 2033 — HOW MANY label tests does the realistic (`MIXED=1`) hop count actually run?
#
# The profile puts `evalLabelExpr` at 46.2% (2203 ms) of a 4769 ms run, and my arithmetic from a
# GUESSED test count (2 per edge x 60,000 edges x 2000 reps = 120M) gives ~18 ns a test — 3x the
# 5.5 ns item 1599 measured for the same function on a seeded count. Either the count is wrong or
# this call site is doing more work per test. A counter decides it; arithmetic on a share does not,
# which is the exact mistake item 1599's own heading corrects ("the dismissal was arithmetic on a
# share, not a measurement").
#
# INSTRUMENTATION ONLY — never shipped. It adds a `globalThis` counter to the two label entry
# points in `graph-queries.ts`.
#
# RESTORE REBUILDS (item 2031: a restored SOURCE with a stale DIST measures the experiment under
# the control's name, because `@lenke/*` resolve to dist).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/graph-queries.ts
PRISTINE=$ROOT/crates/lenke-engine/target/graph-queries.pristine.2033.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE — refusing"; exit 1; }

ANCHOR='const evalLabelExpr = (expr: LabelExpr, labels: ReadonlySet<string>): boolean => {'
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

# Count only the OUTERMOST call: the function recurses for and/or/not, and counting recursive
# entries would inflate a conjunction into several "tests". A plain label is one entry either way,
# and the probe's query uses plain labels.
sed -i "s@const evalLabelExpr = (expr: LabelExpr, labels: ReadonlySet<string>): boolean => {@const evalLabelExpr = (expr: LabelExpr, labels: ReadonlySet<string>): boolean => {\n  (globalThis as Record<string, number>).__LBL = ((globalThis as Record<string, number>).__LBL ?? 0) + 1;@" "$SRC" || exit 1

grep -cF '__LBL' "$SRC" | grep -q '^1$' || { print -- "COUNTER NOT SET"; exit 1; }
(cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || { print -- "BUILD FAILED"; exit 1; }

for m in 0 1; do
  (cd "$ROOT/packages/native" && MIXED=$m NODES=20000 FANOUT=3 LBL_REPORT=1 timeout 900 bun runtime-profile-probe.mjs hopfilter 2>&1 | grep -E "labelTests|\"ms\"" | sed "s/^/  MIXED='$m' /")
done
