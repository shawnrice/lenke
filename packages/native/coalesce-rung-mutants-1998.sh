#!/bin/zsh
# Item 1998 — mutation round on the fused `coalesce(hop, hop)` route.
#
# ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the 2,435-test gremlin suite passes with every mutant below
# ([[perf-gate-needs-its-own-test]]). The filter is the route's OWN test file, which is the only
# thing that can see them.
#
# ⚠️ A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE, and `bun test` reports to STDERR
# (CLAUDE.md; items 767/772-773 got this wrong in both directions). Each run concatenates both
# streams, looks for a `N pass`/`N fail` line there, and only then reads the status.
#
# ⚠️⚠️ **THE PRISTINE COPY IS VERIFIED GREEN BEFORE IT IS TRUSTED, and the first run of this script
# is why.** It aborted mid-loop on a zsh error (`status` is read-only), leaving mutant 1 in the tree;
# the next run then copied THAT to "pristine", so every later round restored a mutated file and
# mutant 1 reported ANCHOR-DID-NOT-APPLY because its anchor was already gone. CLAUDE.md's "restore
# before applying the next mutant" is necessary but not sufficient — an interrupted loop also
# poisons the baseline, and the route file is UNTRACKED so `git` could not restore it. The guard
# below runs the test once against the candidate pristine and refuses to proceed if it is not green.
#
# ⚠️ FIELD SEPARATOR IS `@@`, NOT `|`: a sed expression containing `||` (the `!drops ||` guard) gets
# chopped by `${rest#*|}` and sed then dies with "unknown command: '|'". That is a silent
# ANCHOR-DID-NOT-APPLY in the first version of this script.
#
# ⚠️ GREP ANCHORS ARE THE LITERAL SOURCE TEXT, UNESCAPED. The sed expression needs `\[1\]`; `grep -F`
# does not, and an escaped anchor matches nothing — which the first run reported for three mutants.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/coalesce-hop-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/coalesce-hop-values.pristine.1998.ts
TEST=src/executor/coalesce-hop-values.test.ts

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

# name @@ literal anchor (must appear at least once, and CHANGE) @@ sed expression
MUTANTS=(
  "three-arms-accepted@@plans.length !== 2@@s/plans\.length !== 2/plans.length < 2/"
  "both-arms-are-arm0@@optionalSingleHop(wrapper.plans[1])@@s/optionalSingleHop(wrapper.plans\[1\])/optionalSingleHop(wrapper.plans[0])/"
  "arms-swapped@@{ first, second, ...picked }@@s/{ first, second, \.\.\.picked }/{ first: second, second: first, ...picked }/"
  "csr-on-first-ask@@seenBefore(graph, first.kind === 'out', first.labels[0])@@s/seenBefore(graph, first\.kind === 'out', first\.labels\[0\])/true/"
  "csr-never-falls-back@@if (from === to) {@@s/if (from === to) {/if (from === to \&\& false) {/g"
  "bucket-always-falls-back@@if (any) {@@s/if (any) {/if (false) {/"
  "narrowed-source-accepted@@(source.ids?.length ?? 0) > 0@@s/(source\.ids?\.length ?? 0) > 0/(source.ids?.length ?? 0) > 1/"
  "drain-keeps-undefined@@if (!drops || value !== undefined) {@@s/if (!drops || value !== undefined) {/if (true) {/g"
  "pick-ignores-direction@@forward ? e.to : e.from@@s/forward ? e\.to : e\.from/forward ? e.from : e.to/g"
  "values-two-keys-accepted@@proj.keys.length === 1@@s/proj\.keys\.length === 1/proj.keys.length >= 1/"
)

print -- "mutant                      anchors  ran  verdict"

for spec in "${MUTANTS[@]}"; do
  name=${spec%%@@*}
  rest=${spec#*@@}
  anchor=${rest%%@@*}
  expr=${rest#*@@}

  # RESTORE FIRST, never only after the loop.
  cp "$PRISTINE" "$SRC" || exit 1

  # ⚠️ ASSERT THE ARM IS THE CODE IT CLAIMS BEFORE BUILDING IT (CLAUDE.md). A sed that matches zero
  # times leaves the pristine file in place and its pass is a null that looks like a survivor.
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
