#!/bin/zsh
# Item 2027 — mutation round on the optional rung's unconsumed COUNT terminal.
#
# ⚠️⚠️ **FIRST, DOES THE TEST FILE REACH THE NEW CODE AT ALL?** Item 2018 wrote 13 tests for a new
# path and every walk mutant SURVIVED them, because rungs above answered each shape and the new code
# never ran. The `count-never-fused` mutant below is that check made permanent: it forces
# `fusableProjectedCount` to return false, so the fused case declines everywhere. It is
# ANSWER-EQUIVALENT — the generic route gives the same numbers — so it SHOULD survive the answer
# tests, and `routes` below is what must catch it.
#
# TWO FILTERS, read separately:
#   narrow — `src/executor/optional-hop-values.test.ts`, this item's own
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
SRC=$ROOT/packages/gremlin/src/executor/optional-hop-values.ts
PRISTINE=$ROOT/crates/lenke-engine/target/optional-hop-values.pristine.2027.ts

run_filter() {
  out=$(cd "$ROOT/packages/gremlin" && timeout 300 bun test "$1" 2>&1)
  rc=$?
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')
}

cp "$SRC" "$PRISTINE" || exit 1

run_filter src/executor/optional-hop-values.test.ts
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
  # ---- THE COUNT TERMINAL ----
  "count-declined@@  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;@@s@proj.kind === 'count' ?@false ?@"
  "count-consumed@@  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;@@s@drops: false, consumed: false } : undefined;@drops: false, consumed: true } : undefined;@"
  # ⚠️ EXPECTED SURVIVOR, UNOBSERVABLE BY CONSTRUCTION: `drops` skips a pick that returns
  # `undefined`, and this pick is `(e) => e` — an element, never `undefined`. Same for the bare arm.
  "count-drops@@  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;@@s@{ pick: (e) => e, drops: false, consumed: false }@{ pick: (e) => e, drops: true, consumed: false }@"
  # ⚠️ EXPECTED SURVIVOR: a COUNT observes only HOW MANY values are emitted, never which, so the
  # pick is unobservable here. `(e) => e` is kept because it is the element a FUTURE residual would
  # need (a `values(k)` after the count's position, say) — correct by intent, not by test.
  "count-picks-id@@  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;@@s@count' ? { pick: (e) => e,@count' ? { pick: (e) => e.id,@"
  "count-admits-any-kind@@  return proj.kind === 'count' ?@@s@  return proj.kind === 'count' ?@  return true ?@"
  # ---- THE `rest` SLICE, which the `consumed` flag drives ----
  "rest-always-three@@    rest: steps.slice(picked.consumed ? 3 : 2),@@s@steps.slice(picked.consumed ? 3 : 2)@steps.slice(3)@"
  "rest-always-two@@    rest: steps.slice(picked.consumed ? 3 : 2),@@s@steps.slice(picked.consumed ? 3 : 2)@steps.slice(2)@"
  # ---- THE SIBLINGS whose `consumed` the flag also sets ----
  # ⚠️ EXPECTED SURVIVOR, UNOBSERVABLE BY CONSTRUCTION: the bare arm is reached only when `proj` is
  # `undefined`, i.e. the plan has exactly TWO steps — and `slice(2)` and `slice(3)` are both `[]`
  # there. A third step would be SEEN as `proj` and never reach this arm.
  "bare-marked-consumed@@    return { pick: (e) => e, drops: false, consumed: false };@@s@    return { pick: (e) => e, drops: false, consumed: false };@    return { pick: (e) => e, drops: false, consumed: true };@"
  "values-marked-unconsumed@@    return { pick: (e) => e.properties[valueKey], drops: true, consumed: true };@@s@drops: true, consumed: true };@drops: true, consumed: false };@"
  "id-marked-unconsumed@@    return { pick: (e) => e.id, drops: false, consumed: true };@@s@    return { pick: (e) => e.id, drops: false, consumed: true };@    return { pick: (e) => e.id, drops: false, consumed: false };@"
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

  run_filter src/executor/optional-hop-values.test.ts
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
