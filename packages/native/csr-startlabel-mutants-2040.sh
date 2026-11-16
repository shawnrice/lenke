#!/bin/zsh
# Item 2040 — mutation round on the CSR start-label arm.
#
# ⚠️⚠️ **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/csr-start-label.test.ts`, this item's own
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
SRC=$ROOT/packages/gremlin/src/executor/hop-values-csr.ts
PRISTINE=$ROOT/crates/lenke-engine/target/hop-values-csr.pristine.2040b.ts

run_filter() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/csr-start-label.test.ts
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
# ⚠️ `vtx[slot]` IS THE START AND `vtx[memo.flat[i]]` IS THE NEIGHBOUR — the swap mutant is here
# because those two are one character apart in shape and the arm is answer-equivalent either way on a
# fixture where every vertex shares a label (which is why the tests use a HALF-covered graph).
MUTANTS=(
  "iterator-ignores-startTest@@      if (startTest !== undefined && !startTest(vtx[slot])) {@@s@startTest !== undefined \&\& !startTest(vtx\[slot\])@false@"
  "drain-ignores-startTest@@      if (startTest?.(vtx[slot]) === false) {@@s@startTest?.(vtx\[slot\]) === false@false@"
  "startTest-inverted@@      if (startTest !== undefined && !startTest(vtx[slot])) {@@s@\&\& !startTest(vtx\[slot\])@\&\& startTest(vtx[slot])@"
  "startTest-on-neighbour@@      if (startTest !== undefined && !startTest(vtx[slot])) {@@s@!startTest(vtx\[slot\])@!startTest(vtx[memo.flat[memo.off[slot]]] ?? vtx[slot])@"
  "coverage-gate-always@@const CSR_START_LABEL_MIN_COVERAGE = 0.1;@@s@= 0.1;@= 0;@"
  "coverage-gate-never@@const CSR_START_LABEL_MIN_COVERAGE = 0.1;@@s@= 0.1;@= 2;@"
  "multiname-admitted@@    steps[1]?.kind === 'hasLabel' && steps[1].labels.length === 1 ? steps[1] : undefined;@@s@labels.length === 1@labels.length >= 1@"
  "rest-ignores-label-shift@@    rest: steps.slice((picked.consumesProj ? 3 : 2) + (labelStep === undefined ? 0 : 1)),@@s@+ (labelStep === undefined ? 0 : 1)@@"
  "coverage-uses-wrong-total@@  const total = graph.vertexCount;@@s@graph.vertexCount@(graph.vertexCount || 1) * 10@"
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

  run_filter src/executor/csr-start-label.test.ts
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
