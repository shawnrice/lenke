#!/bin/zsh
# Item 2016 — mutation round on the flat edge array and the rung's flat arm.
#
# ANSWER-EQUIVALENT ROUTE, so the whole gremlin suite passes with every mutant below. The filters
# are the two files' OWN tests ([[perf-gate-needs-its-own-test]]).
#
# TWO SOURCE FILES, so each mutant names which one it edits. `second-ask.ts` is mutated too,
# because the `kind` namespace is a PERFORMANCE contract — a mutant dropping it changes no answer
# anywhere, and only `edge-flat.test.ts`'s namespace test can see it.
#
# Harness rules, all earned at items 1998-2015 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted.
#   - PER-MUTANT `timeout`; exit 124 IS the catch.
#   - FIELD SEPARATOR `@@`; a `|` separator chops a sed expression containing `||`.
#   - GREP ANCHORS ARE LITERAL SOURCE TEXT, and the replacement must NOT contain the anchor, or
#     `n == after` reads as not-applied (item 2015's harness could not tell an insertion from a
#     no-op, which was the right call and cost two mutants).
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
G=$ROOT/packages/gremlin/src/executor
PRIS=$ROOT/crates/lenke-engine/target/edge-flat-pristine-2016
TESTS=(src/executor/edge-flat.test.ts src/executor/edge-filtered-hop-values.test.ts)

mkdir -p "$PRIS" || exit 1

run_tests() {
  out=''
  rc=0
  ran=0
  for t in "${TESTS[@]}"; do
    o=$(cd "$ROOT/packages/gremlin" && timeout 120 bun test "$t" 2>&1)
    r=$?
    out="$out$o"
    ran=$((ran + $(print -- "$o" | grep -cE '^ *[0-9]+ (pass|fail)')))
    # EACH SUITE'S STATUS READ SEPARATELY. Item 2002's harness read `$?` from the last command in
    # a subshell and reported six phantom survivors.
    if [[ "$r" != "0" ]]; then
      rc=$r
    fi
  done
}

for f in edge-flat.ts edge-filtered-hop-values.ts second-ask.ts; do
  cp "$G/$f" "$PRIS/$f" || exit 1
done

restore() {
  for f in edge-flat.ts edge-filtered-hop-values.ts second-ask.ts; do
    cp "$PRIS/$f" "$G/$f" || exit 1
  done
}

run_tests

if [[ "$ran" == "0" || "$rc" != "0" ]]; then
  print -- "BASELINE IS NOT GREEN (ran=$ran rc=$rc) — refusing to mutate."
  print -- "$out" | tail -20
  exit 1
fi

print -- "baseline green (ran=$ran suites). mutating.\n"

MUTANTS=(
  # ---- edge-flat.ts: THE ORDER, which is the whole correctness argument ----
  "flat-reversed@@edge-flat.ts@@      flat.push(edge);@@s@      flat.push(edge);@      flat.unshift(edge);@"
  "flat-ignores-direction@@edge-flat.ts@@outward ? v.adjFrom?.get(type) : v.adjTo?.get(type)@@s@outward ? v.adjFrom?.get(type) : v.adjTo?.get(type)@v.adjFrom?.get(type)@"
  "flat-ignores-type@@edge-flat.ts@@v.adjFrom?.get(type) : v.adjTo?.get(type)@@s@v.adjFrom?.get(type) : v.adjTo?.get(type)@v.adjFrom?.values().next().value : v.adjTo?.get(type)@"
  "flat-empty-guard-dropped@@edge-flat.ts@@    if (bucket === undefined) {@@s@    if (bucket === undefined) {@    if (false) {@"
  # ---- edge-flat.ts: THE CACHE ----
  "cache-never-invalidated@@edge-flat.ts@@entry === undefined || entry.tv !== tv@@s@entry === undefined || entry.tv !== tv@entry === undefined@"
  "cache-never-hits@@edge-flat.ts@@  if (hit !== undefined) {@@s@  if (hit !== undefined) {@  if (false) {@"
  "flat-key-ignores-direction@@edge-flat.ts@@outward ? '>' : '<'@@s@outward ? '>' : '<'@'>'@"
  # ---- edge-filtered-hop-values.ts: THE FLAT ARM ----
  "flat-arm-never-taken@@edge-filtered-hop-values.ts@@    if (spec.flat) {@@s@    if (spec.flat) {@    if (false) {@"
  "flat-arm-always-taken@@edge-filtered-hop-values.ts@@    if (spec.flat) {@@s@    if (spec.flat) {@    if (true) {@"
  "ALL-THREE-walks-test-dropped@@edge-filtered-hop-values.ts@@    if (!edgeTest(edge)) {@@s@    if (!edgeTest(edge)) {@    if (false) {@"
  "flat-arm-emits-nothing@@edge-filtered-hop-values.ts@@  const flat = edgeFlatFor(graph, outward, type);@@s@  const flat = edgeFlatFor(graph, outward, type);@  const flat = [];@"
  "flat-arm-skips-first-edge@@edge-filtered-hop-values.ts@@  for (let i = 0; i < flat.length; i += 1) {@@s@  for (let i = 0; i < flat.length; i += 1) {@  for (let i = 1; i < flat.length; i += 1) {@"
  "ALL-THREE-walks-drops-ignored@@edge-filtered-hop-values.ts@@    if (!drops || value !== undefined) {@@s@    if (!drops || value !== undefined) {@    if (true) {@"
  "second-ask-bypassed@@edge-filtered-hop-values.ts@@const flat = seenBefore(graph, outward, type, 'e');@@s@const flat = seenBefore(graph, outward, type, 'e');@const flat = true;@"
  "second-ask-namespace-dropped@@edge-filtered-hop-values.ts@@seenBefore(graph, outward, type, 'e')@@s@seenBefore(graph, outward, type, 'e')@seenBefore(graph, outward, type)@"
  # ---- second-ask.ts: the namespace itself ----
  "kind-ignored@@second-ask.ts@@{kind}\${forward@@s@{kind}.{forward@{forward@"
)

print -- "mutant                           file                            anchors  ran  verdict"

for spec in "${MUTANTS[@]}"; do
  name=${spec%%@@*}
  r1=${spec#*@@}
  file=${r1%%@@*}
  r2=${r1#*@@}
  anchor=${r2%%@@*}
  expr=${r2#*@@}

  if [[ "$expr" == "SKIP" ]]; then
    # A MULTI-LINE ANCHOR CANNOT MATCH UNDER `grep -F`, so these are reported rather than run
    # silently. Item 2015's harness refused two of mine for exactly this and that was correct.
    print -- "${(r:32:: :)name} ${(r:31:: :)file} ${(l:7:: :)0}  ---  MULTILINE-ANCHOR (not run)"
    continue
  fi

  restore

  SRC=$G/$file
  n=$(grep -F -c -- "$anchor" "$SRC")
  sed -i -e "$expr" "$SRC"
  after=$(grep -F -c -- "$anchor" "$SRC")

  if [[ "$n" == "0" || "$n" == "$after" ]]; then
    print -- "${(r:32:: :)name} ${(r:31:: :)file} ${(l:7:: :)n}  ---  ANCHOR-DID-NOT-APPLY"
    continue
  fi

  run_tests

  if [[ "$ran" == "0" ]]; then
    verdict="DID-NOT-RUN"
  elif [[ "$rc" == "0" ]]; then
    verdict="SURVIVED  <-- no teeth here"
  elif [[ "$rc" == "124" || "$rc" == "137" ]]; then
    verdict="CAUGHT (non-termination, exit $rc)"
  else
    verdict="CAUGHT (exit $rc; fails: $(print -- "$out" | grep -oE '[0-9]+ fail' | tr '\n' ' '))"
  fi

  print -- "${(r:32:: :)name} ${(r:31:: :)file} ${(l:7:: :)n}  ${(l:3:: :)ran}  $verdict"
done

restore
run_tests
print -- "\nrestored; baseline re-verified: ran=$ran rc=$rc"
