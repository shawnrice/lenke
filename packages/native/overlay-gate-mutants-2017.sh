#!/bin/zsh
# Item 2017 — mutation round on the ORDER BY overlay gate.
#
# **NOT A ROUTE CHOICE: A WRONG GATE HERE IS A WRONG ANSWER**, so unlike items 2014-2016 the
# broad suite can see some of these. That is exactly why the round must run the WIDE filter as well
# as the narrow one — a mutant caught only by `sort-overlay-gate.test.ts` tells me that file has
# teeth; a mutant caught by NEITHER tells me the engine has a hole.
#
# TWO FILTERS, each read separately:
#   narrow — `src/sort-overlay-gate.test.ts`, item 2017's own
#   wide   — the whole @lenke/gql suite, which is where an ORDER BY regression would surface
#
# Harness rules, earned at items 1998-2016 and kept verbatim:
#   - PRISTINE IS VERIFIED GREEN before it is trusted.
#   - PER-MUTANT `timeout`; exit 124 IS the catch.
#   - FIELD SEPARATOR `@@`; a `|` separator chops a sed expression containing `||`.
#   - THE REPLACEMENT MUST NOT CONTAIN THE ANCHOR, or `n == after` reads as not-applied.
#   - AND `grep -F` COUNTS LINES CONTAINING THE PATTERN, so a LESS-indented anchor matches a
#     MORE-indented line (item 2016 corrected item 2015's comment, which had this backwards).
#   - A VERDICT NEEDS EVIDENCE OF EXECUTION, and `bun test` reports to STDERR.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
PRISTINE=$ROOT/crates/lenke-engine/target/projection.pristine.2017.ts

run_filter() {
  out=$(cd "$ROOT/packages/gql" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/sort-overlay-gate.test.ts
nrc=$rc
nran=$ran
run_filter src/
wrc=$rc
wran=$ran

if [[ "$nran" == "0" || "$nrc" != "0" || "$wran" == "0" || "$wrc" != "0" ]]; then
  print -- "BASELINE IS NOT GREEN (narrow ran=$nran rc=$nrc / wide ran=$wran rc=$wrc) — refusing."
  print -- "$out" | tail -25
  exit 1
fi

print -- "baseline green, both filters. mutating.\n"

MUTANTS=(
  # NO `&&` IN AN ANCHOR. zsh keeps `\&` literal inside double quotes, so an anchor containing
  # `&&` never matches and SIX mutants reported ANCHOR-DID-NOT-APPLY on the first round. Anchor on
  # the `?`-expression instead, which is unique to each branch by its `b`/`rep` names.
  # ---- THE GATE, non-aggregating branch ----
  "plain-gate-inverted@@proj.orderNeedsOutput ? new Map([...b, ...projected]) : b;@@s@proj.orderNeedsOutput ? new Map(\[...b, ...projected\]) : b;@proj.orderNeedsOutput === false ? new Map([...b, ...projected]) : b;@"
  "plain-overlay-never@@proj.orderNeedsOutput ? new Map([...b, ...projected]) : b;@@s@proj.orderNeedsOutput ? new Map(\[...b, ...projected\]) : b;@false ? new Map([...b, ...projected]) : b;@"
  "plain-overlay-always@@proj.orderNeedsOutput ? new Map([...b, ...projected]) : b;@@s@proj.orderNeedsOutput ? new Map(\[...b, ...projected\]) : b;@true ? new Map([...b, ...projected]) : b;@"
  "plain-overlay-reversed@@new Map([...b, ...projected]) : b;@@s@new Map(\[...b, ...projected\]) : b;@new Map([...projected, ...b]) : b;@"
  "plain-overlay-only-projected@@new Map([...b, ...projected]) : b;@@s@new Map(\[...b, ...projected\]) : b;@new Map([...projected]) : b;@"
  "plain-overlay-only-input@@new Map([...b, ...projected]) : b;@@s@new Map(\[...b, ...projected\]) : b;@new Map([...b]) : b;@"
  # ---- THE GATE, aggregating branch ----
  "agg-gate-inverted@@proj.orderNeedsOutput ? new Map([...rep, ...projected]) : rep;@@s@proj.orderNeedsOutput ? new Map(\[...rep, ...projected\]) : rep;@proj.orderNeedsOutput === false ? new Map([...rep, ...projected]) : rep;@"
  "agg-overlay-never@@proj.orderNeedsOutput ? new Map([...rep, ...projected]) : rep;@@s@proj.orderNeedsOutput ? new Map(\[...rep, ...projected\]) : rep;@false ? new Map([...rep, ...projected]) : rep;@"
  "agg-overlay-reversed@@new Map([...rep, ...projected]) : rep;@@s@new Map(\[...rep, ...projected\]) : rep;@new Map([...projected, ...rep]) : rep;@"
  "agg-overlay-only-input@@new Map([...rep, ...projected]) : rep;@@s@new Map(\[...rep, ...projected\]) : rep;@new Map([...rep]) : rep;@"
)

print -- "mutant                          anchors  narrow            wide"

verdict_of() {
  if [[ "$2" == "0" ]]; then
    print -- "DID-NOT-RUN"
  elif [[ "$1" == "0" ]]; then
    print -- "survived"
  elif [[ "$1" == "124" || "$1" == "137" ]]; then
    print -- "CAUGHT(exit $1)"
  else
    print -- "CAUGHT"
  fi
}

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
    print -- "${(r:31:: :)name} ${(l:7:: :)n}  ANCHOR-DID-NOT-APPLY"
    continue
  fi

  run_filter src/sort-overlay-gate.test.ts
  nv=$(verdict_of "$rc" "$ran")
  run_filter src/
  wv=$(verdict_of "$rc" "$ran")

  flag=''
  if [[ "$nv" == "survived" && "$wv" == "survived" ]]; then
    flag='  <-- NO TEETH ANYWHERE'
  fi

  print -- "${(r:31:: :)name} ${(l:7:: :)n}  ${(r:17:: :)nv} ${(r:15:: :)wv}$flag"
done

cp "$PRISTINE" "$SRC" || exit 1
run_filter src/
print -- "\nrestored; wide baseline re-verified: ran=$ran rc=$rc"
