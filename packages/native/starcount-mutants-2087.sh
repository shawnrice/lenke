#!/bin/zsh
# Item 2087 — mutation round on the chain count(*) level-recurrence rung.
#
# **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/chain-star-count.test.ts`, this item's own
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
SRC=${MSRC:-$ROOT/packages/gql/src/executor/chain-fold-levels.ts}
PRISTINE=$ROOT/crates/lenke-engine/target/cfl.pristine.2087m.ts

run_filter() {
  # `&` IN A sed REPLACEMENT MEANS THE WHOLE MATCH, so patching this line with sed inserted the
  # match into the middle of its own `2>&1`. Item 2081's note says exactly this; written with a file
  # tool instead.
  out=$(cd "${MPKG:-$ROOT/packages/gremlin}" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/chain-star-count.test.ts
nrc=$rc nran=$ran
run_filter src/
wrc=$rc wran=$ran

if [[ "$nran" == "0" || "$nrc" != "0" || "$wran" == "0" || "$wrc" != "0" ]]; then
  print -- "BASELINE NOT GREEN (narrow ran=$nran rc=$nrc / wide ran=$wran rc=$wrc) — refusing."
  print -- "$out" | tail -25
  exit 1
fi

print -- "baseline green, both filters. mutating.\n"

# THE SAME GATE NOW APPEARS IN FOUR RUNGS (the `optional` one from item 2027 included), so each
# mutant is scoped to ONE FILE via $SRC — a repo-wide line anchor would edit all four and the verdict
# would cover four decisions at once (item 2020's over-broad mutant, item 2018's extraction).
# EVERY MUTANT IS ANSWER-EQUIVALENT OR NOT, and the ones that are must still be CAUGHT — by the
# gate tests (accept/decline) or by the iterator/drain agreement. A route choice alone changes no
# answer, which is why this rung needed its own tests ([[perf-gate-needs-its-own-test]]).
# THE RESIDUAL IS ANSWER-AFFECTING IN ONE DIRECTION AND ROUTE-ONLY IN THE OTHER: dropping a
# trailing `order` changes the ANSWER (the sequence), while refusing to fuse it only changes the
# ROUTE. Both are in the battery, and only the route-only ones need a test that asserts a route.
# EVERY MUTANT HERE IS ANSWER-PRESERVING OR ANSWER-BREAKING, and the answer-preserving ones are the
# point: this rewrite changes a ROUTE, and the route was already correct. Only the plan-shape
# assertions can catch them.
# EVERY MUTANT HERE IS ANSWER-PRESERVING OR ANSWER-BREAKING, and the answer-preserving ones are the
# point: this rewrite changes a ROUTE, and the route was already correct. Only the plan-shape
# assertions can catch them.
#
# LITERAL SINGLE QUOTES, not \x27 — these are DOUBLE-quoted zsh strings, where a single quote needs
# no escape at all. The first round used \x27 and all four quote-bearing anchors reported
# ANCHOR-DID-NOT-APPLY, which reads like a stale anchor rather than a quoting mistake.
# LITERAL SINGLE QUOTES inside these DOUBLE-quoted zsh strings — item 2047 lost four anchors to
# \x27 escapes that zsh does not expand.
# `?` IS NOT ESCAPED IN THESE PATTERNS. GNU sed BRE reads `\?` as "zero or one of the previous"
# — so `\?\?` is nonsense and five anchors reported ANCHOR-DID-NOT-APPLY while matching the source
# exactly. A literal `?` needs no escape in BRE, and the same is true of `(`, `)` and `|`.
# BRACKETS ARE ESCAPED IN EVERY PATTERN. `props[key]` in a sed BRE is a CHARACTER CLASS — it
# matches `props` followed by one of k/e/y, never the literal text — so four mutants reported
# ANCHOR-DID-NOT-APPLY while their anchors matched the source exactly. Earlier items in this directory
# escape them; this one did not, and the sed silently matched nothing. (`?` is the opposite case: a
# literal in BRE, broken by escaping it — item 2080.)
MUTANTS=(
  "rung-never-fires@@  if (!proj.aggregating || !proj.countedGroups || proj.items.length !== 1) {@@/^export const detectChainStarCount/,/^};/ s@!proj.aggregating || !proj.countedGroups@true@"
  "admits-a-non-star-count@@  if (!proj.aggregating || !proj.countedGroups || proj.items.length !== 1) {@@/^export const detectChainStarCount/,/^};/ s@ || !proj.countedGroups@@"
  "admits-LIMIT@@  if (proj.skip !== undefined || proj.limit !== undefined || (proj.orderBy?.length ?? 0) > 0) {@@/^export const detectChainStarCount/,/^};/ s@ || proj.limit !== undefined@@"
  "admits-SKIP@@  if (proj.skip !== undefined || proj.limit !== undefined || (proj.orderBy?.length ?? 0) > 0) {@@/^export const detectChainStarCount/,/^};/ s@proj.skip !== undefined || @@"
  "admits-a-grouped-count@@  if ((proj.groupKeys?.length ?? 0) > 0) {@@/^export const detectChainStarCount/,/^};/ s@(proj.groupKeys?.length ?? 0) > 0@false@"
  "decline-never-fires@@    if (chainLabelsAllVacuous(graph, startLabel, levels)) {@@/^export const detectChainStarCount/,/^};/ s@chainLabelsAllVacuous(graph, startLabel, levels)@false@"
  "decline-always-fires@@    if (chainLabelsAllVacuous(graph, startLabel, levels)) {@@/^export const detectChainStarCount/,/^};/ s@chainLabelsAllVacuous(graph, startLabel, levels)@true@"
  "vacuity-ignores-the-levels@@  vacuousOrAbsent(graph, startLabel) && levels.every((l) => vacuousOrAbsent(graph, l.label));@@/^export const chainLabelsAllVacuous/,/^  vacuousOrAbsent/ s@ && levels.every((l) => vacuousOrAbsent(graph, l.label))@@"
  "vacuity-ignores-the-start@@  vacuousOrAbsent(graph, startLabel) && levels.every((l) => vacuousOrAbsent(graph, l.label));@@/^export const chainLabelsAllVacuous/,/^  vacuousOrAbsent/ s@vacuousOrAbsent(graph, startLabel) && @@"
  "level-label-mask-dropped@@    if (level.label !== undefined) {@@/^const levelWalk/,/^};/ s@if (level.label !== undefined) {@if (false) {@"
  "start-label-mask-dropped@@    u[i] = startLabel === undefined || first.order[i].labels.has(startLabel) ? 1 : 0;@@/^const levelWalk/,/^};/ s@startLabel === undefined || first.order\[i\].labels.has(startLabel)@true@"
  "vacuousOrAbsent-always-true@@  name === undefined || vacuousLabel(graph, { kind: 'label', name });@@/^const vacuousOrAbsent/,/^};/ s@name === undefined || vacuousLabel(graph, { kind: 'label', name })@true@"
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

  run_filter src/executor/chain-star-count.test.ts
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
