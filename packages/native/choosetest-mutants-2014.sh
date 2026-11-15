#!/bin/zsh
# Item 2014 — mutation round on the `choose(<hop test>, <value arm>, <value arm>)` rung.
#
# ⚠️ ANSWER-EQUIVALENT ROUTE, so the 2,464-test gremlin suite passes with every mutant below. The
# filter is the route's OWN test file ([[perf-gate-needs-its-own-test]]).
#
# Harness rules, all earned at items 1998-2005 and kept verbatim:
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
SRC=$ROOT/packages/gremlin/src/executor/choose-test-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/choose-test-values.pristine.2014.ts
TEST=src/executor/choose-test-values.test.ts

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
  # THE TEST
  "test-inverted@@hopHasAny(graph, v, test) ? thenArm : otherwise@@s/hopHasAny(graph, v, test) ? thenArm : otherwise/hopHasAny(graph, v, test) ? otherwise : thenArm/"
  "test-always-true@@hopHasAny(graph, v, test) ? thenArm@@s/hopHasAny(graph, v, test) ? thenArm/true ? thenArm/"
  "bucket-size-ignored@@return direct.set.size > 0;@@s/return direct.set.size > 0;/return true;/"
  "fallback-never-true@@    return true;@@s/    return true;/    return false;/"
  # THE ARMS — the semantics the pricing fixture could not see.
  "values-emits-undefined@@if (own !== undefined) {@@s/if (own !== undefined) {/if (true) {/"
  "identity-yields-constant@@      if (arm.kind === 'identity') {@@s/      if (arm.kind === 'identity') {/      if (false) {/"
  "absent-else-drops@@      if (arm === undefined) {@@s/      if (arm === undefined) {/      if (false) {/"
  # THE GATE
  "narrowed-source-accepted@@(source.ids?.length ?? 0) > 0@@s/(source\\.ids?\\.length ?? 0) > 0/(source.ids?.length ?? 0) > 1/"
  "values-two-keys-accepted@@only.keys.length === 1@@s/only\\.keys\\.length === 1/only.keys.length >= 1/"
  "multistep-arm-accepted@@if (plan.steps.length !== 1) {@@s/if (plan.steps.length !== 1) {/if (false) {/"
  "filter-test-accepted@@if (test === undefined) {@@s/if (test === undefined) {/if (false) {/"
  "else-decline-dropped@@wrapper.elsePlan !== undefined && otherwise === null@@s/wrapper\\.elsePlan !== undefined \&\& otherwise === null/false/"
)

print -- "mutant                       anchors  ran  verdict"

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
    print -- "${(r:28:: :)name} ${(l:7:: :)n}  ---  ANCHOR-DID-NOT-APPLY"
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

  print -- "${(r:28:: :)name} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

cp "$PRISTINE" "$SRC" || exit 1
run_test
print -- "\nrestored; baseline re-verified: ran=$ran rc=$rc"
