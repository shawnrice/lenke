#!/bin/zsh
# Item 1999 — mutation round on the fused `choose(<vertex filter>, hop, hop)` route.
#
# ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the 2,447-test gremlin suite passes with every mutant below.
# The filter is the route's OWN test file ([[perf-gate-needs-its-own-test]]).
#
# Harness rules, all earned at item 1998 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted. An interrupted loop otherwise leaves a mutant
#     in the tree and the next run copies THAT as the baseline; the route file is untracked, so git
#     cannot restore it.
#   - FIELD SEPARATOR IS `@@`: a `|` separator chops a sed expression containing `||`.
#   - GREP ANCHORS ARE THE LITERAL SOURCE TEXT, unescaped — a sed-escaped `\[0\]` matches nothing
#     under `grep -F`, which reads as a survivor if it is not checked.
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR. Concatenate both
#     streams, find a result line, and only then read the exit code.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/choose-hop-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/choose-hop-values.pristine.1999.ts
TEST=src/executor/choose-hop-values.test.ts

run_test() {
  out=$(cd "$ROOT/packages/gremlin" && bun test "$TEST" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1
run_test

if [[ "$ran" == "0" || "$rc" != "0" ]]; then
  print -- "BASELINE IS NOT GREEN (ran=$ran rc=$rc) — refusing to mutate against a poisoned pristine."
  print -- "$out" | tail -20
  exit 1
fi

print -- "baseline green. mutating.\n"

MUTANTS=(
  # THE GATE
  "seekable-test-refused@@collectVertexFilters(wrapper.test.steps, graph, false)@@s/collectVertexFilters(wrapper\.test\.steps, graph, false)/collectVertexFilters(wrapper.test.steps, graph)/"
  # ⚠️ TWO GATE MUTANTS WERE DELETED RATHER THAN GIVEN TEETH. `empty-test-admitted` and
  # `hop-test-admitted` both SURVIVED, and investigating why found the code they mutated was DEAD:
  # `collectVertexFilters` already refuses a non-filter step, and the `every(isVertexFilterStep)`
  # guard in front of it was strictly NARROWER than it (it declined `hasKey`). The mutants are gone
  # because the lines are gone; the route test now pins the widened surface instead.
  "collect-failure-ignored@@if (filters === undefined) {@@s/if (filters === undefined) {/if (false) {/"
  "narrowed-source-accepted@@(source.ids?.length ?? 0) > 0@@s/(source\.ids?\.length ?? 0) > 0/(source.ids?.length ?? 0) > 1/"
  "values-two-keys-accepted@@proj.keys.length === 1@@s/proj\.keys\.length === 1/proj.keys.length >= 1/"
  "multistep-arm-admitted@@thenHop === undefined ||@@s/thenHop === undefined ||/false ||/"
  # THE TEST EVALUATION
  "test-inverted@@survives(v, gates) ? thenHop : elseHop@@s/survives(v, gates) ? thenHop : elseHop/survives(v, gates) ? elseHop : thenHop/"
  "csr-test-inverted@@const take = survives(v, gates);@@s/const take = survives(v, gates);/const take = !survives(v, gates);/g"
  "test-always-true@@const take = survives(v, gates);@@s/const take = survives(v, gates);/const take = true;/g"
  # THE ARMS
  "absent-else-drops@@if (hop === undefined) {@@s/if (hop === undefined) {/if (false) {/g"
  "csr-on-first-ask@@seenBefore(graph, hop.kind === 'out', hop.labels[0])@@s/seenBefore(graph, hop\.kind === 'out', hop\.labels\[0\])/true/"
  "csr-wrong-direction@@chainCsrFor(graph, hop.kind === 'out', [hop.labels[0]])@@s/chainCsrFor(graph, hop\.kind === 'out', \[hop\.labels\[0\]\])/chainCsrFor(graph, hop.kind !== 'out', [hop.labels[0]])/"
  "one-arm-is-enough@@bothServed &&@@s/bothServed \&\&/true \&\&/"
  "drain-keeps-undefined@@if (!drops || value !== undefined) {@@s/if (!drops || value !== undefined) {/if (true) {/g"
)

print -- "mutant                      anchors  ran  verdict"

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
    print -- "${(r:27:: :)name} ${(l:7:: :)n}  ---  ANCHOR-DID-NOT-APPLY"
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

  print -- "${(r:27:: :)name} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

cp "$PRISTINE" "$SRC" || exit 1
run_test
print -- "\nrestored; baseline re-verified: ran=$ran rc=$rc"
