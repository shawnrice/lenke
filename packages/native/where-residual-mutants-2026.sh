#!/bin/zsh
# Item 2026 — mutation round on the existence-filtered scan rung's RESIDUAL sibling.
#
# **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/node-values-where.test.ts`, this item's own
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
SRC=$ROOT/packages/gremlin/src/executor/node-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/node-values.pristine.2026.ts

run_filter() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/node-values-where.test.ts
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
  # ---- THE PREFIX LENGTH, which is the whole gate ----
  "prefix-no-residual-admitted@@  if (steps.length <= 3) {@@/export const scanWhereValuesResidual/,/^};/s@  if (steps.length <= 3) {@  if (false) {@"
  "prefix-takes-two-steps@@  const values = nodeValuesWhereShortcut({ ...plan, steps: steps.slice(0, 3) }, graph);@@s@steps.slice(0, 3)@steps.slice(0, 2)@"
  "prefix-takes-four-steps@@  const values = nodeValuesWhereShortcut({ ...plan, steps: steps.slice(0, 3) }, graph);@@s@steps.slice(0, 3)@steps.slice(0, 4)@"
  # ---- THE RESIDUAL'S CONTENT (item 2021's lesson: the VALUE is the contract) ----
  "residual-off-by-one@@  return values === undefined ? undefined : { values, rest: steps.slice(3) };@@s@rest: steps.slice(3)@rest: steps.slice(4)@"
  "residual-empty@@  return values === undefined ? undefined : { values, rest: steps.slice(3) };@@s@rest: steps.slice(3)@rest: []@"
  "residual-whole-plan@@  return values === undefined ? undefined : { values, rest: steps.slice(3) };@@s@rest: steps.slice(3)@rest: steps@"
  # ANSWER-EQUIVALENT: the pipeline answers identically, so this SHOULD survive the answer tests
  # and must be caught by the residual's own assertions.
  "residual-never-fused@@  if (steps.length <= 3) {@@/export const scanWhereValuesResidual/,/^};/s@  if (steps.length <= 3) {@  if (true) {@"
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

  run_filter src/executor/node-values-where.test.ts
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
