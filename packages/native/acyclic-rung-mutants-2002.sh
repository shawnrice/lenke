#!/bin/zsh
# Item 2002 — mutation round on the ACYCLIC per-source DFS count route.
#
# **THIS ROUTE IS NOT ANSWER-EQUIVALENT, unlike items 1998/1999's — it computes a count that
# nothing else in the engine computes.** So the filter here is wider: the cross-engine parity test
# (TS against the Rust engine's INDEPENDENT implementation, on a graph with self-loops, 2-cycles, a
# triangle and parallel edges) plus the 4,980-test GQL suite. A mutant that changes the answer should
# be caught by parity; one that only changes the ROUTE should be caught by nothing, and that
# distinction is the point of running this.
#
# Harness rules, all earned at items 1998/1999 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted (an interrupted loop poisons the baseline, and
#     a new file is untracked so git cannot restore it).
#   - FIELD SEPARATOR IS `@@` (a `|` separator chops a sed expression containing `||`).
#   - GREP ANCHORS ARE LITERAL SOURCE TEXT, unescaped.
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/acyclic-count.ts
PRISTINE=$ROOT/crates/lenke-engine/target/acyclic-count.pristine.2002.ts

# **THE PARITY TEST READS THE BUILT DIST, NOT `src`** ([[fuzzers-read-built-dists]]): it lives in
# `packages/native` and imports `@lenke/gql`, which resolves to `dist`. So every mutant needs a
# REBUILD before it is tested, or the whole round measures the pristine build and reports 14
# survivors. The gql suite reads `src` directly and does not.
# **EACH SUITE'S STATUS IS READ SEPARATELY, and the first version of this function did NOT do
# that — it ran both in one `$( ... ; ... )` and read `$?`, which is the status of the LAST command
# only.** So every mutant caught by the PARITY test but not by the GQL suite was reported SURVIVED.
# It reported six survivors; `min-ignored` was then caught by hand on the very first check (2 fail).
# This is CLAUDE.md's "piping clippy into grep takes grep's exit status" in a new costume, and it
# invalidated the entire first round rather than one row of it.
run_test() {
  build=$(cd "$ROOT" && bun run build 2>&1)
  brc=$?
  pout=$(cd "$ROOT/packages/native" && bun test src/acyclic-selfloop-parity.test.ts 2>&1)
  prc=$?
  gout=$(cd "$ROOT/packages/gql" && bun test 2>&1)
  grc=$?
  out="$pout
$gout"
  # EITHER failing is a catch. Read as separate statuses, never chained.
  rc=0
  [[ "$prc" != "0" || "$grc" != "0" ]] && rc=1
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1
run_test

if [[ "$ran" == "0" || "$rc" != "0" || "$brc" != "0" ]]; then
  print -- "BASELINE IS NOT GREEN (ran=$ran rc=$rc build=$brc) — refusing to mutate."
  print -- "$out" | tail -20
  exit 1
fi

print -- "baseline green (build ok, $ran result lines). mutating.\n"

MUTANTS=(
  # THE RESTRICTION ITSELF — these must change the answer.
  "no-acyclicity@@if (seen.has(w)) {@@s/if (seen.has(w)) {/if (false) {/"
  "source-not-marked@@seen.add(slot);@@s/seen.add(slot);//"
  "no-backtrack@@seen.delete(w);@@s/seen.delete(w);//"
  "seen-not-cleared@@seen.clear();@@s/seen.clear();//"
  # THE LENGTH BOOKKEEPING
  "min-ignored@@len >= 1 && len >= min@@s/len >= 1 \&\& len >= min/len >= 1/"
  "only-deepest-counted@@len >= 1 && len >= min@@s/len >= 1 \&\& len >= min/len === max/"
  "off-by-one-start@@extend(slot, 0);@@s/extend(slot, 0);/extend(slot, 1);/"
  "depth-unbounded@@if (len === max) {@@s/if (len === max) {/if (false) {/"
  # THE PREDICATES
  "endpoint-test-dropped@@&& passes(order[v])@@s/\&\& passes(order\[v\])//"
  "seed-filter-dropped@@unfiltered.filter((v) => seedPasses(v))@@s/unfiltered.filter((v) => seedPasses(v))/unfiltered/"
  # THE SOURCES
  "missing-slot-counted@@if (slot === undefined) {@@s/if (slot === undefined) {/if (false) {/"
  "inward-ignored@@csrFor(graph, inward, types)@@s/csrFor(graph, inward, types)/csrFor(graph, false, types)/"
  # ROUTE-ONLY — expected SURVIVORS, and saying so in advance is the point.
  "budget-always-blows@@const WORK_FACTOR = 64;@@s/const WORK_FACTOR = 64;/const WORK_FACTOR = 0;/"
  "budget-never-blows@@if (work > budget) {@@s/if (work > budget) {/if (false) {/"
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

  if [[ "$brc" != "0" ]]; then
    # A mutant that does not COMPILE is caught, but say so distinctly — it is weaker evidence than
    # a failing assertion, because it says nothing about what the tests can see.
    verdict="CAUGHT (build failed — compile-only)"
  elif [[ "$ran" == "0" ]]; then
    verdict="DID-NOT-RUN"
  elif [[ "$rc" == "0" ]]; then
    verdict="SURVIVED"
  elif [[ "$rc" == "124" || "$rc" == "137" ]]; then
    verdict="CAUGHT (non-termination, exit $rc)"
  else
    verdict="CAUGHT (parity=$prc gql=$grc: $(print -- "$out" | grep -oE '[0-9]+ fail' | head -1))"
  fi

  print -- "${(r:27:: :)name} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

cp "$PRISTINE" "$SRC" || exit 1
run_test
print -- "\nrestored; baseline re-verified: build=$brc ran=$ran rc=$rc"
