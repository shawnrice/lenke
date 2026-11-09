#!/usr/bin/env bash
# Item 1750: the VALID ceiling for `satisfies`' section chain.
#
# Item 1749's arm deleted the section holding the actual predicate, so both its numbers were void.
# This one deletes only the nine sections a FIELD CENSUS proved empty for every measured shape
# (hopfilter populates eqProps only; existssub where+eqProps; hopall nothing at all), keeping props,
# eqProps and where. Verified answer-equivalent by the probe's own assertions before timing: 20000 /
# 207 / 207, matching base.
#
# `hopall` is the purest row: no predicate at all, so `satisfies` runs the whole chain to do nothing.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gql/src/executor/predicates.ts
BASE=$R/crates/lenke-engine/target/pristine-1749-base.ts
ARM=$R/crates/lenke-engine/target/pristine-1750-arm.ts
D=$R/packages/gql/dist/esm/index.mjs
for round in 1 2 3; do
  for arm in base thin; do
    if [ "$arm" = base ]; then cp "$BASE" "$S"; else cp "$ARM" "$S"; fi
    (cd "$R/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    # Code-level counts, both ways (item 1749: a comment is stripped, and truthTestProps is on the
    # compile side too). These two helpers are called only from `satisfies`, once each.
    got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
lab = t.count('labelTestsHold(')
typ = t.count('typedTestsHold(')
if lab == 1 and typ == 1: print('base')
elif lab == 0 and typ == 0: print('thin')
else: print(f'UNEXPECTED lab={lab} typ={typ}')
")
    [ "$got" = "$arm" ] || { echo "ARM-ASSERT-FAILED $arm saw $got"; continue; }
    echo "arm-assert ok   $arm"
    for s in hopall hopall hopall hopfilter existssub; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 900 node runtime-profile-probe.mjs "$s" 1500 2>&1 | tail -1)
    done
  done
done
cp "$BASE" "$S"
(cd "$R/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored BASE"
