#!/bin/zsh
# Item 2015 — mutation round on the `branch(values(k)).option(m, <arm>)….none(<arm>)` rung.
#
# ANSWER-EQUIVALENT ROUTE, so the whole gremlin suite passes with every mutant below. The filter
# is the route's OWN test file ([[perf-gate-needs-its-own-test]]).
#
# Harness rules, all earned at items 1998-2014 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted (an interrupted loop otherwise poisons the
#     baseline, and a new file is untracked so git cannot restore it).
#   - PER-MUTANT `timeout`, because a mutant is arbitrary broken code and a non-allocating hang never
#     trips the cgroup cap. Exit 124 IS the catch.
#   - FIELD SEPARATOR `@@`: a `|` separator chops a sed expression containing `||`.
#   - GREP ANCHORS ARE LITERAL SOURCE TEXT, unescaped — a sed-escaped `\[0\]` matches nothing under
#     `grep -F`, which reads as a survivor if it is not checked.
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/branch-value-hop.ts
PRISTINE=$ROOT/crates/lenke-engine/target/branch-value-hop.pristine.2015.ts
TEST=src/executor/branch-value-hop.test.ts

run_test() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 120 bun test "$TEST" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1
run_test

if [[ "$ran" == "0" || "$rc" != "0" ]]; then
  print -- "BASELINE IS NOT GREEN (ran=$ran rc=$rc) — refusing to mutate."
  print -- "$out" | tail -20
  exit 1
fi

print -- "baseline green. mutating.\n"

MUTANTS=(
  # THE TEST — `in` vs a truthiness check, and the fallback route.
  "test-reads-wrong-key@@byValue.get(props[testKey])@@s@byValue.get(props\[testKey\])@byValue.get(testKey)@"
  "fallback-never-used-generator@@byValue.get(props[testKey]) ?? fallback@@s@byValue.get(props\[testKey\]) ?? fallback@byValue.get(props[testKey])@"
  "fallback-never-used-drain@@byValue.get((v as Element).properties[testKey]) ?? fallback@@s@byValue.get((v as Element).properties\[testKey\]) ?? fallback@byValue.get((v as Element).properties[testKey])@"
  # THE WALK — the drop, the identity arm.
  "unmatched-not-dropped@@      if (arm === undefined) {@@s/      if (arm === undefined) {/      if (false) {/"
  "identity-arm-hops@@      if (arm.kind === 'identity') {@@s/      if (arm.kind === 'identity') {/      if (false) {/"
  "values-emits-undefined@@        if (!drops || own !== undefined) {@@s/        if (!drops || own !== undefined) {/        if (true) {/"
  # THE GATE
  "narrowed-source-accepted@@(source.ids?.length ?? 0) > 0@@s/(source\.ids?\.length ?? 0) > 0/(source.ids?.length ?? 0) > 1/"
  "multikey-test-accepted@@testStep.keys.length !== 1@@s/testStep\.keys\.length !== 1/testStep.keys.length < 1/"
  "multistep-test-accepted@@wrapper.test.steps.length !== 1 ||@@s/wrapper\.test\.steps\.length !== 1 ||/false ||/"
  "nonprimitive-key-accepted@@    if (!keyable(opt.match)) {@@s/    if (!keyable(opt.match)) {/    if (false) {/"
  "nan-key-accepted@@Number.isFinite(k)@@s@Number.isFinite(k)@true@"
  "null-key-accepted@@typeof k === 'string'@@s@typeof k === 'string'@k === null@"
  "refused-none-read-as-absent@@  if (fallback === null) {@@s/  if (fallback === null) {/  if (false) {/"
  "refused-option-arm-accepted@@    if (arm === null) {@@s/    if (arm === null) {/    if (false) {/"
  "duplicate-key-last-wins@@    if (!byValue.has(opt.match)) {@@s/    if (!byValue.has(opt.match)) {/    if (true) {/"
  "multikey-projection-accepted@@proj.keys.length === 1@@s/proj\.keys\.length === 1/proj.keys.length >= 1/"
  # THE DRAIN — the second copy of the loop, and the one `toArray` actually reaches. EVERY WALK
  # MUTANT ABOVE HITS THE GENERATOR ONLY, so without these the eager fill is untested: they are
  # caught by the generator-vs-drain agreement test, which is the only assertion that sees both.
  # TEN SPACES vs EIGHT is what makes each anchor unique — the identity arm's push is nested one
  # level deeper than the hop arm's. `grep -F` counts LINES CONTAINING the pattern, so the 8-space
  # line does not contain the 10-space one and the counts are honest.
  "drain-identity-arm-emits-nothing@@          out.push(own);@@s@          out.push(own);@          void own;@"
  "drain-hop-arm-emits-nothing@@      for (const own of hopArm(graph, v, arm.hop, pick, drops)) {@@s@      for (const own of hopArm(graph, v, arm.hop, pick, drops)) {@      for (const own of []) {@"
)

print -- "mutant                           anchors  ran  verdict"

for spec in "${MUTANTS[@]}"; do
  name=${spec%%@@*}
  rest=${spec#*@@}
  anchor=${rest%%@@*}
  expr=${rest#*@@}

  cp "$PRISTINE" "$SRC" || exit 1

  n=$(grep -F -c -- "$anchor" "$SRC")
  sed -i -e "$expr" "$SRC"
  after=$(grep -F -c -- "$anchor" "$SRC")

  if [[ "$n" == "0" || "$n" == "$after" ]]; then
    print -- "${(r:32:: :)name} ${(l:7:: :)n}  ---  ANCHOR-DID-NOT-APPLY"
    continue
  fi

  run_test

  if [[ "$ran" == "0" ]]; then
    verdict="DID-NOT-RUN"
  elif [[ "$rc" == "0" ]]; then
    verdict="SURVIVED  <-- no teeth here"
  elif [[ "$rc" == "124" || "$rc" == "137" ]]; then
    verdict="CAUGHT (non-termination, exit $rc)"
  else
    verdict="CAUGHT ($(print -- "$out" | grep -oE '[0-9]+ fail' | head -1))"
  fi

  print -- "${(r:32:: :)name} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

cp "$PRISTINE" "$SRC" || exit 1
run_test
print -- "\nrestored; baseline re-verified: ran=$ran rc=$rc"
