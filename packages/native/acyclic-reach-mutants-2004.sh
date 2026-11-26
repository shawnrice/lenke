#!/bin/zsh
# Item 2004 — mutation round on the ACYCLIC reached-set DFS arm in `reachability.ts`.
#
# FILTER IS THE CROSS-ENGINE PARITY TEST **AND** THE GQL SUITE, each status read SEPARATELY.
# Item 2002's harness ran both in one subshell and read `$?` — the LAST command's status — so every
# mutant caught by parity alone reported SURVIVED. It printed six phantom survivors. That bug is
# fixed here from the start, and it matters more in this file: the route is pinned by GQL route
# tests while the ANSWER is pinned cross-engine, so the two filters catch different things.
#
# THE PARITY TEST READS THE BUILT DIST ([[fuzzers-read-built-dists]]), so each mutant needs a
# REBUILD before it is tested or the round measures the pristine build.
#
# PRISTINE IS VERIFIED GREEN before it is trusted — an interrupted loop otherwise poisons the
# baseline, and `reachability.ts` IS tracked so `git` could restore it, but the guard costs nothing.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/reachability.ts
PRISTINE=$ROOT/crates/lenke-engine/target/reachability.pristine.2004.ts

# **BUILDS ONLY `@lenke/gql`, AND THE FIRST VERSION'S FULL-MONOREPO BUILD MADE THIS ROUND
# UNRUNNABLE.** `bun run build` at the root rebuilds all 21 packages — about 2.5 minutes — so 14
# mutants came to ~38 minutes, and the round had to be killed after 6. The parity test imports
# `@lenke/gql` and nothing else that changes here, and `nx build @lenke/gql` takes **6 seconds**:
# a 25x harness win for a one-line change, on a script whose whole job is to be run repeatedly.
#
# AND IT DOES NOT PIPE ITS OUTPUT THROUGH `tail`. The first run did, which buffers everything
# until exit — so a 16-minute round showed an EMPTY progress file and there was no way to tell
# "working" from "wedged" without killing it.
run_test() {
  build=$(cd "$ROOT" && npx nx build @lenke/gql --skip-nx-cache 2>&1)
  brc=$?
  # **EACH SUITE IS UNDER ITS OWN `timeout`, AND OMITTING THAT STALLED THIS ROUND TWICE.**
  # CLAUDE.md: "Run every mutant under a timeout AND a memory cap … a mutant is arbitrary broken
  # code, so it can hang or allocate without bound — treat that as the normal case." The cgroup cap
  # was here from the start; the TIMEOUT was not, and one mutant is guaranteed to need it:
  # `depth-unbounded` removes the DFS's depth cap, so on the 62-vertex parity fixture (degree ~5,
  # 2-cycles everywhere) it enumerates every acyclic path in the graph. That does not allocate
  # without bound, so `MemoryMax` never fires — exactly the case CLAUDE.md says the memory cap cannot
  # catch. Exit 124 IS the catch, not a harness failure.
  pout=$(cd "$ROOT/packages/native" && timeout 120 bun test src/acyclic-selfloop-parity.test.ts 2>&1)
  prc=$?
  gout=$(cd "$ROOT/packages/gql" && timeout 180 bun test 2>&1)
  grc=$?
  out="$pout
$gout"
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
  # THE RESTRICTION — these must change the answer.
  "no-acyclicity@@if (onPath[w] === 1) {@@s/if (onPath\[w\] === 1) {/if (false) {/"
  "seed-not-on-path@@onPath[slot] = 1;@@s/onPath\[slot\] = 1;//"
  "no-backtrack@@onPath[w] = 0;@@s/onPath\[w\] = 0;//"
  # DECLARED EXPECTED SURVIVOR, with a proof rather than a shrug. Deleting the seed-slot unwind is
  # ANSWER-EQUIVALENT: `walkSlot` unwinds every other mark itself, so the only residue is the seed's
  # own slot, and routing a later seed through an earlier one can never reach anything that seed
  # missed (the depth cost is `1 + depth-from-that-seed`, strictly worse than its own walk). No
  # fixture can kill it. Its PREDECESSOR — an `onPath.fill(0)` before each walk — survived for the
  # same reason, and that survival is what found a 1.39x: the fill was O(|V|) per seed, i.e.
  # O(|V|^2) on an unseeded query, and provably removable.
  "seed-slot-not-unwound@@onPath[slot] = 0;@@s/onPath\[slot\] = 0;//"
  # THE ANSWER-vs-PATH CONFUSION, which is the defect this arm's note warns about: using the
  # ANSWER marker as the path marker prunes a vertex from every later path once any path reached it.
  "answer-used-as-path@@if (onPath[w] === 1) {@@s/if (onPath\[w\] === 1) {/if (inAnswer[w] === 1) {/"
  # DEPTH AND DIRECTION
  "depth-off-by-one@@if (len === maxLen) {@@s/if (len === maxLen) {/if (len === maxLen + 1) {/"
  "depth-unbounded@@if (len === maxLen) {@@s/if (len === maxLen) {/if (false) {/"
  "direction-ignored@@csrFor(graph, !out, types)@@s/csrFor(graph, !out, types)/csrFor(graph, false, types)/"
  "types-ignored@@csrFor(graph, !out, types)@@s/csrFor(graph, !out, types)/csrFor(graph, !out, undefined)/"
  # THE ANSWER SET
  "answer-dupes@@if (inAnswer[w] === 0) {@@s/if (inAnswer\[w\] === 0) {/if (true) {/"
  "missing-slot-counted@@if (slot === undefined) {@@s/if (slot === undefined) {/if (false) {/"
  # THE GATE — route-only for the BFS modes, answer-changing for unbounded acyclic.
  "unbounded-acyclic-admitted@@p.segments[0].rel.quantifier.max !== null@@s/p\.segments\[0\]\.rel\.quantifier\.max !== null/true/"
  "acyclic-mode-refused@@mode === 'acyclic' &&@@s/mode === 'acyclic' \&\&/false \&\&/"
  "spec-flag-never-set@@(m.patterns[0].mode ?? 'trail') === 'acyclic'@@s/(m\.patterns\[0\]\.mode ?? 'trail') === 'acyclic'/false/"
)

print -- "mutant                        anchors  ran  verdict"

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
    print -- "${(r:29:: :)name} ${(l:7:: :)n}  ---  ANCHOR-DID-NOT-APPLY"
    continue
  fi

  run_test

  if [[ "$brc" != "0" ]]; then
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

  print -- "${(r:29:: :)name} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

cp "$PRISTINE" "$SRC" || exit 1
run_test
print -- "\nrestored; baseline re-verified: build=$brc ran=$ran rc=$rc"
