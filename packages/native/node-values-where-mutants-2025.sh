#!/bin/zsh
# Item 2025 — mutation round on the existence-filtered scan rung.
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
PRISTINE=$ROOT/crates/lenke-engine/target/node-values.pristine.2025.ts

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
  # ---- THE WALK ----
  "test-inverted@@    if (!hasAdjacency(v, hop)) {@@s@    if (!hasAdjacency(v, hop)) {@    if (hasAdjacency(v, hop)) {@"
  "test-always-true@@    if (!hasAdjacency(v, hop)) {@@s@    if (!hasAdjacency(v, hop)) {@    if (false) {@"
  "values-emits-undefined@@    if (key in props) {@@s@    if (key in props) {@    if (true) {@"
  # EXPECTED SURVIVOR, AND UNOBSERVABLE BY CONSTRUCTION rather than untested. The value model
  # maps a stored `undefined` to NULL ([[numeric-model-f64]]), so a PRESENT key never reads
  # `undefined` and the two tests cannot differ on any reachable graph. `key in props` is kept
  # because it is `projectValues`' own rule — consistency with the engine, not an observable.
  # ALSO NOTE anchors=5: that line appears in all five walks in this file, so a line anchor edits
  # every one of them. Scoped to this rung's walk with a sed address range (item 2020's lesson).
  "values-presence-to-undefined@@    if (key in props) {@@/const nodeValuesWhereWalk/,/^};/s@    if (key in props) {@    if (props[key] !== undefined) {@"
  # ---- THE GATE ----
  "gate-admits-pred-where@@  if (filter.kind !== 'where' || !('plan' in filter)) {@@s@  if (filter.kind !== 'where' || !('plan' in filter)) {@  if (filter.kind !== 'where') {@"
  "gate-admits-any-step@@  if (filter.kind !== 'where' || !('plan' in filter)) {@@s@  if (filter.kind !== 'where' || !('plan' in filter)) {@  if (false) {@"
  "gate-admits-multikey@@  if (proj.kind !== 'values' || proj.keys.length !== 1) {@@s@proj.keys.length !== 1@proj.keys.length < 1@"
  "gate-admits-narrowed-source@@  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {@@/export const nodeValuesWhereShortcut/,/^};/s@(source.ids?.length ?? 0) > 0@(source.ids?.length ?? 0) > 1@"
  "gate-admits-four-steps@@  if (steps.length !== 3) {@@/export const nodeValuesWhereShortcut/,/^};/s@  if (steps.length !== 3) {@  if (steps.length < 3) {@"
  # ANSWER-EQUIVALENT: the pipeline answers identically, so this SHOULD survive the answer tests
  # and must be caught by a ROUTE assertion. Item 2018's lesson as a standing check.
  "rung-never-fires@@  if (steps.length !== 3) {@@/export const nodeValuesWhereShortcut/,/^};/s@  if (steps.length !== 3) {@  if (true) {@"
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
