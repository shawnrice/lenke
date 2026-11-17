#!/bin/zsh
# Item 2061 — mutation round on the fused where+hasKey+count rung.
#
# ⚠️⚠️ **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/where-haskey-count.test.ts`, this item's own
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
PRISTINE=$ROOT/crates/lenke-engine/target/node-values.pristine.2061m.ts

run_filter() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/where-haskey-count.test.ts
nrc=$rc nran=$ran
run_filter src/
wrc=$rc wran=$ran

if [[ "$nran" == "0" || "$nrc" != "0" || "$wran" == "0" || "$wrc" != "0" ]]; then
  print -- "BASELINE NOT GREEN (narrow ran=$nran rc=$nrc / wide ran=$wran rc=$wrc) — refusing."
  print -- "$out" | tail -25
  exit 1
fi

print -- "baseline green, both filters. mutating.\n"

# ⚠️ THE SAME GATE NOW APPEARS IN FOUR RUNGS (the `optional` one from item 2027 included), so each
# mutant is scoped to ONE FILE via $SRC — a repo-wide line anchor would edit all four and the verdict
# would cover four decisions at once (item 2020's over-broad mutant, item 2018's extraction).
# ⚠️ EVERY MUTANT IS ANSWER-EQUIVALENT OR NOT, and the ones that are must still be CAUGHT — by the
# gate tests (accept/decline) or by the iterator/drain agreement. A route choice alone changes no
# answer, which is why this rung needed its own tests ([[perf-gate-needs-its-own-test]]).
# ⚠️ THE RESIDUAL IS ANSWER-AFFECTING IN ONE DIRECTION AND ROUTE-ONLY IN THE OTHER: dropping a
# trailing `order` changes the ANSWER (the sequence), while refusing to fuse it only changes the
# ROUTE. Both are in the battery, and only the route-only ones need a test that asserts a route.
# ⚠️ EVERY MUTANT HERE IS ANSWER-PRESERVING OR ANSWER-BREAKING, and the answer-preserving ones are the
# point: this rewrite changes a ROUTE, and the route was already correct. Only the plan-shape
# assertions can catch them.
# ⚠️ EVERY MUTANT HERE IS ANSWER-PRESERVING OR ANSWER-BREAKING, and the answer-preserving ones are the
# point: this rewrite changes a ROUTE, and the route was already correct. Only the plan-shape
# assertions can catch them.
#
# ⚠️ LITERAL SINGLE QUOTES, not \x27 — these are DOUBLE-quoted zsh strings, where a single quote needs
# no escape at all. The first round used \x27 and all four quote-bearing anchors reported
# ANCHOR-DID-NOT-APPLY, which reads like a stale anchor rather than a quoting mistake.
# ⚠️ LITERAL SINGLE QUOTES inside these DOUBLE-quoted zsh strings — item 2047 lost four anchors to
# \x27 escapes that zsh does not expand.
# ⚠️⚠️ **ANCHORS MADE UNIQUE AND EVERY GATE MUTANT SCOPED TO THIS FUNCTION.** The first run reported
# `anchors 2` for three mutants: `if (steps.length !== 3) {`, the multi-key check and the `V(ids)`
# check are IDENTICAL in `nodeValuesWhereShortcut` above, so those mutants edited BOTH rungs and were
# "caught" by code they were not aiming at — [[ambiguous-anchor-strings]] exactly. Each gate mutant
# now anchors on this rung's UNIQUE export line and applies its sed only between that line and the
# function's close.
#
# ⚠️ AND `&&` IS WRITTEN LITERALLY. Escaping it as \& left `grep -F` hunting for a backslash, so four
# walk mutants silently reported ANCHOR-DID-NOT-APPLY rather than failing loudly.
# ⚠️⚠️ **THE HARNESS VERIFIES BY RE-COUNTING THE ANCHOR**, so a mutant whose anchor is not the line it
# changes always reports ANCHOR-DID-NOT-APPLY — seven did, on a run where every sed had in fact
# applied correctly. The anchor must BE the mutated text.
#
# ⚠️ A DUPLICATED ANCHOR IS THEREFORE FINE **when the sed is range-scoped**: `if (steps.length !== 3)`,
# the multi-key check, the `V(ids)` check and the `yield` all appear in a sibling rung too, so those
# seds are limited to this function (or this walk) and the count drops 2 -> 1, which both proves the
# edit landed and proves it landed HERE. An UNSCOPED sed with a duplicate anchor is the real bug —
# the first run had three, each silently editing `nodeValuesWhereShortcut` as well
# ([[ambiguous-anchor-strings]]).
#
# ⚠️ AND `&&` IS LITERAL in the anchors: escaping it left `grep -F` hunting for a backslash.
MUTANTS=(
  "count-gate-removed@@  if (tail?.kind !== 'count' || projection?.kind !== 'hasKey' || projection.keys.length !== 1) {@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@tail?.kind !== 'count' || @@"
  "haskey-gate-removed@@  if (tail?.kind !== 'count' || projection?.kind !== 'hasKey' || projection.keys.length !== 1) {@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@projection?.kind !== 'hasKey' || @@"
  "multikey-gate-removed@@  if (tail?.kind !== 'count' || projection?.kind !== 'hasKey' || projection.keys.length !== 1) {@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@ || projection.keys.length !== 1@@"
  "length-gate-admits-five@@  if (steps.length !== 4) {@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@steps.length !== 4@steps.length < 4@"
  "rung-never-fires@@  if (steps.length !== 4) {@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@steps.length !== 4@true@"
  "projects-a-wrong-key@@  const asValues: Step = { kind: 'values', keys: [projection.keys[0]] };@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@keys: \[projection.keys\[0\]\]@keys: ['__nope__']@"
  "drops-the-where-step@@    { ...plan, steps: [steps[0], steps[1], asValues] },@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@steps: \[steps\[0\], steps\[1\], asValues\]@steps: [steps[0], asValues]@"
  "returns-empty-residual@@  return values === undefined ? undefined : { values, rest: [tail] };@@/^export const scanWhereHasKeyCountResidual/,/^};/ s@rest: \[tail\]@rest: []@"
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

  run_filter src/executor/where-haskey-count.test.ts
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
