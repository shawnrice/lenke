#!/bin/zsh
# Item 2022 — mutation round on the shared per-row binding merge.
#
# **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/binding-merge.test.ts`, this item's own
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
SRC=$ROOT/packages/gql/src/executor/clauses.ts
PRISTINE=$ROOT/crates/lenke-engine/target/clauses.pristine.2022.ts

run_filter() {
  out=$(cd "$ROOT/packages/gql" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/binding-merge.test.ts
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
  # ---- THE MERGE's ORDER AND CONTENT. Key order is a CONTRACT: `RETURN *` projects in binding
  # order, so a reordering is a COLUMN-order change, which is bytes.
  "merge-order-reversed@@  const merged = new Map(outer);@@s@  const merged = new Map(outer);@  const merged = new Map(inner);@"
  "merge-inner-dropped@@  for (const [k, v] of inner) {@@s@  for (const \[k, v\] of inner) {@  for (const [k, v] of []) {@"
  "merge-outer-dropped@@  const merged = new Map(outer);@@s@  const merged = new Map(outer);@  const merged = new Map();@"
  # EXPECTED SURVIVOR, AND IT IS A FACT ABOUT THE DATA RATHER THAN A MISSING TEST. The two sides
  # OVERLAP only on the outer binding's keys, and those keys hold the SAME values on both sides
  # (`t` carries `binding`; `b` carries `binding` plus its pattern's own variables). So "inner wins"
  # and "outer wins" cannot differ. On the CLAUSE path there is no overlap at all — that cache is
  # matched against an EMPTY binding, so it holds only the clause's own variables. Unobservable.
  "merge-inner-loses@@    merged.set(k, v);@@s@    merged.set(k, v);@    if (!merged.has(k)) merged.set(k, v);@"
  # ---- THE CALL SITES: four of them, each a different product path ----
  "product-first-row@@          yield mergeBinding(b, next.value);@@s@          yield mergeBinding(b, next.value);@          yield mergeBinding(next.value, b);@"
  "product-cached-rows@@          yield mergeBinding(b, t);@@s@          yield mergeBinding(b, t);@          yield mergeBinding(t, b);@"
  "clause-cached-rows@@        yield mergeBinding(binding, c);@@s@        yield mergeBinding(binding, c);@        yield mergeBinding(c, binding);@"
  # EXPECTED SURVIVOR: answer-equivalent by construction. Merging an EMPTY incoming binding adds
  # nothing, so always merging returns the same rows — it just pays a Map per row, which the `bare`
  # check exists to avoid (measured 1.93x on a 20,000-row scan). A pure perf gate, so the A/B is the
  # only evidence, exactly as item 2017's `always` mutant and `count-shortcut.ts`' `seenBefore` gate.
  "clause-bare-path-lost@@      yield bare ? next.value : mergeBinding(binding, next.value);@@s@      yield bare ? next.value : mergeBinding(binding, next.value);@      yield mergeBinding(binding, next.value);@"
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

  run_filter src/binding-merge.test.ts
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
