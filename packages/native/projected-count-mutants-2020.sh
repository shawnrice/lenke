#!/bin/zsh
# Item 2020 — mutation round on the fused `count()` residual.
#
# **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/projected-count.test.ts`, this item's own
#   wide   — the whole @lenke/gremlin suite
#
# Harness rules, earned at items 1998-2019 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted.
#   - PER-MUTANT `timeout`; exit 124 IS the catch.
#   - `@@` separator; NO `&&` IN AN ANCHOR (zsh keeps `\&` literal in double quotes).
#   - THE REPLACEMENT MUST NOT CONTAIN THE ANCHOR, or `n == after` reads as not-applied.
#   - `grep -F` COUNTS LINES CONTAINING the pattern, so a LESS-indented anchor matches a
#     MORE-indented line (item 2016 corrected item 2015 on this).
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/aggregation.ts
PRISTINE=$ROOT/crates/lenke-engine/target/aggregation.pristine.2020.ts

run_filter() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/projected-count.test.ts
nrc=$rc nran=$ran
run_filter src/
wrc=$rc wran=$ran

if [[ "$nran" == "0" || "$nrc" != "0" || "$wran" == "0" || "$wrc" != "0" ]]; then
  print -- "BASELINE NOT GREEN (narrow ran=$nran rc=$nrc / wide ran=$wran rc=$wrc) — refusing."
  print -- "$out" | tail -25
  exit 1
fi

print -- "baseline green, both filters. mutating.\n"

MUTANTS=(
  # ---- THE COUNT ITSELF ----
  "count-off-by-one@@    n += 1;@@s@    n += 1;@    n += 2;@"
  "count-ignores-drain@@  values.drain === undefined ? countIterable(values) : values.drain().length,@@s@values.drain === undefined ? countIterable(values) : values.drain().length,@countIterable(values),@"
  "count-uses-drain-always@@  values.drain === undefined ? countIterable(values) : values.drain().length,@@s@values.drain === undefined ? countIterable(values) : values.drain().length,@values.drain!().length,@"
  "count-not-wrapped@@export const countProjectedWalk = (values: HopWalk): unknown[] => [@@s@: HopWalk): unknown\[\] => \[@: HopWalk): unknown[] => (@"
  # ---- THE GATE ----
  "gate-admits-local-scope@@  return !('scope' in step) || step.scope === undefined || step.scope === 'global';@@s@  return !('scope' in step) || step.scope === undefined || step.scope === 'global';@  return true;@"
  "gate-admits-any-kind@@  if (step.kind !== 'count') {@@s@  if (step.kind !== 'count') {@  if (false) {@"
  # **`  if (rest.length !== 1) {` SITS AT THE SAME INDENT IN FOUR GATES IN THIS FILE** (lines
  # 188/296/394/713), so a line-start anchor edited ALL FOUR and the verdict covered four decisions
  # at once — the same over-broad mutant item 2018 found and fixed by extracting its gate. Here a
  # sed ADDRESS RANGE scopes the edit to this function's body instead. `grep` still counts four
  # (it cannot see the range), but `n != after` still proves the edit landed.
  "gate-admits-longer-rest@@  if (rest.length !== 1) {@@/export const fusableProjectedCount/,/^};/s@  if (rest.length !== 1) {@  if (rest.length === 0) {@"
  # ANSWER-EQUIVALENT: the generic route answers identically, so this SHOULD survive the answer
  # tests and must be caught by a ROUTE assertion. It is item 2018's lesson as a standing check.
  "count-never-fused@@  if (step.kind !== 'count') {@@s@  if (step.kind !== 'count') {@  if (true) {@"
)

print -- "mutant                           anchors  narrow        wide"

verdict_of() {
  if [[ "$2" == "0" ]]; then
    print -- "DID-NOT-RUN"
  elif [[ "$1" == "0" ]]; then
    print -- "survived"
  elif [[ "$1" == "124" || "$1" == "137" ]]; then
    print -- "CAUGHT($1)"
  else
    print -- "CAUGHT"
  fi
}

for spec in "${MUTANTS[@]}"; do
  name=${spec%%@@*}
  rest=${spec#*@@}
  anchor=${rest%%@@*}
  expr=${rest#*@@}

  if [[ "$expr" == "SKIPNL" ]]; then
    print -- "${(r:32:: :)name} ${(l:7:: :)0}  (multiline anchor — not run)"
    continue
  fi

  cp "$PRISTINE" "$SRC" || exit 1

  n=$(grep -F -c -- "$anchor" "$SRC")
  sed -i -e "$expr" "$SRC"
  after=$(grep -F -c -- "$anchor" "$SRC")

  if [[ "$n" == "0" || "$n" == "$after" ]]; then
    print -- "${(r:32:: :)name} ${(l:7:: :)n}  ANCHOR-DID-NOT-APPLY"
    continue
  fi

  run_filter src/executor/projected-count.test.ts
  nv=$(verdict_of "$rc" "$ran")
  run_filter src/
  wv=$(verdict_of "$rc" "$ran")

  flag=''
  if [[ "$nv" == "survived" && "$wv" == "survived" ]]; then
    flag='  <-- NO TEETH ANYWHERE'
  fi

  print -- "${(r:32:: :)name} ${(l:7:: :)n}  ${(r:13:: :)nv} ${(r:13:: :)wv}$flag"
done

cp "$PRISTINE" "$SRC" || exit 1
run_filter src/
print -- "\nrestored; wide baseline re-verified: ran=$ran rc=$rc"
