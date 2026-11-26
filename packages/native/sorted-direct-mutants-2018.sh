#!/bin/zsh
# Item 2018 — mutation round on `sortedRowsDirect` and its gate.
#
# A NEW SORT PATH, so most of these are WRONG ANSWERS rather than route choices — but the four
# GATE refusals are answer-equivalent (the general path answers identically), so those need the
# route assertions in item 2018's own test file ([[perf-gate-needs-its-own-test]]).
#
# TWO FILTERS, read separately:
#   narrow — `src/sorted-rows-direct.test.ts`, this item's own
#   wide   — the whole @lenke/gql suite, where a sort regression surfaces
# A mutant caught by NEITHER is a hole in the engine, not just in my file.
#
# Harness rules, earned at items 1998-2017 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted.
#   - PER-MUTANT `timeout`; exit 124 IS the catch.
#   - `@@` separator; a `|` chops a sed expression containing `||`.
#   - NO `&&` IN AN ANCHOR: zsh keeps `\&` literal in double quotes, which cost item 2017 six
#     mutants to ANCHOR-DID-NOT-APPLY.
#   - THE REPLACEMENT MUST NOT CONTAIN THE ANCHOR, or `n == after` reads as not-applied.
#   - `grep -F` COUNTS LINES CONTAINING the pattern, so a LESS-indented anchor matches a
#     MORE-indented line (item 2016 corrected item 2015 on this).
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
PRISTINE=$ROOT/crates/lenke-engine/target/projection.pristine.2018.ts

run_filter() {
  out=$(cd "$ROOT/packages/gql" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/sorted-rows-direct.test.ts
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
  # ---- THE WALK: what it emits and in what order ----
  "sort-removed@@  keyed.sort(keyedComparator(orderBy));@@s@  keyed.sort(keyedComparator(orderBy));@  void keyedComparator(orderBy);@"
  "keys-reversed@@      keys.push(s.fn(env));@@s@      keys.push(s.fn(env));@      keys.unshift(s.fn(env));@"
  "first-row-dropped@@  for (let i = 0; i < keyed.length; i += 1) {@@s@  for (let i = 0; i < keyed.length; i += 1) {@  for (let i = 1; i < keyed.length; i += 1) {@"
  "projection-skipped@@    const row = projectRow(proj, b, params, graph);@@s@    const row = projectRow(proj, b, params, graph);@    const row = {};@"
  # ---- THE SHARED COMPARATOR (both sort paths read it) ----
  "cmp-ignores-descending@@orderBy[i].descending, orderBy[i].nullsFirst@@s@orderBy\[i\].descending, orderBy\[i\].nullsFirst@false, orderBy[i].nullsFirst@"
  "cmp-ignores-nullsfirst@@orderBy[i].descending, orderBy[i].nullsFirst@@s@orderBy\[i\].descending, orderBy\[i\].nullsFirst@orderBy[i].descending, !orderBy[i].nullsFirst@"
  "cmp-first-key-only@@      if (c !== 0) {@@s@      if (c !== 0) {@      if (true) {@"
  "cmp-key-index-fixed@@compareSort(a.keys[i], b.keys[i]@@s@compareSort(a.keys\[i\], b.keys\[i\]@compareSort(a.keys[0], b.keys[0]@"
  # ---- THE GATE: answer-equivalent, so ONLY `sortedDirectRoute`'s own assertions see these.
  # ANCHORED ON THE EXTRACTED FUNCTION'S BODY, which is unique. Inline, `!proj.aggregating`
  # matched FOUR lines in this file and the mutant silently edited three other decisions too.
  "gate-admits-aggregating@@  !proj.aggregating \&\&\n  !proj.distinct@@SKIPNL"
  "gate-admits-aggregating2@@  !proj.aggregating@@s@^  !proj.aggregating@  true@"
  "gate-admits-distinct@@  !proj.distinct \&@@SKIPNL"
  "gate-admits-distinct2@@  !proj.distinct@@s@^  !proj.distinct@  true@"
  "gate-admits-windowed@@  !windowed \&@@SKIPNL"
  "gate-admits-windowed2@@  !windowed@@s@^  !windowed@  true@"
  "gate-admits-needs-output2@@  !proj.orderNeedsOutput@@s@^  !proj.orderNeedsOutput@  true@"
  "gate-admits-unsorted@@  proj.orderBy.length > 0;@@s@  proj.orderBy.length > 0;@  true;@"
  # "NEVER FIRES" IS THE ROUTE'S OWN NULL, and the last line of the gate is the place to force it:
  # a replacement containing `): boolean =>` cannot be detected as applied.
  "gate-never-fires@@  proj.orderBy.length > 0;@@s@  proj.orderBy.length > 0;@  false;@"
)

# THE `anchors` COLUMN OVER-COUNTS FOR THE `^`-ANCHORED GATE MUTANTS, and that is grep, not sed:
# `grep -F` counts lines CONTAINING "  !proj.distinct", which a FOUR-space line also contains, while
# sed's `^  ` matches only the two-space one. Verified per pattern: each hits exactly ONE line, all
# inside `sortedDirectRoute` (618-621). The inline form it replaced really did have four.

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

  if [[ "$expr" == "SKIPAMP" || "$expr" == "SKIPNL" ]]; then
    print -- "${(r:32:: :)name} ${(l:7:: :)0}  (superseded by its \`2\` twin / multiline)"
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

  run_filter src/sorted-rows-direct.test.ts
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
