#!/usr/bin/env bash
# Item 1749: is `satisfies`' eleven-section chain worth anything?
#
#   base      all 11 sections run per element
#   whereonly ⚠️ CEILING ONLY, WRONG FOR OTHER SHAPES: every section except `pred.where` deleted.
#             Sound for THESE two shapes because a counter confirmed only `where` is populated for
#             them, but it would silently drop constraints elsewhere -- measurement, never a candidate.
#
# The point: a counter showed `satisfies` runs 20,000 times per query (once per candidate, not per
# survivor), so its 44.3% of `hopfilter` is 188.6 ms over 30M calls = 6.3 ns each. That arithmetic
# implies the chain is nearly free; this measures it instead of inferring it.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gql/src/executor/predicates.ts
BASE=$R/crates/lenke-engine/target/pristine-1749-base.ts
D=$R/packages/gql/dist/esm/index.mjs

apply_arm() {
  cp "$BASE" "$S" || exit 90
  if [ "$1" = whereonly ]; then
    python3 - "$S" <<'PY' || exit 91
import sys, re
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
start = t.index("  const env: EvalEnv = { binding, params, graph };")
tail = "  return pred.where === undefined || asTruth(pred.where(env)) === true;"
end = t.index(tail)
head = "  const env: EvalEnv = { binding, params, graph };\n\n  // ZZ-ABLATED: all sections but `where`\n\n"
open(p, 'w', encoding='utf-8').write(t[:start] + head + t[end:])
PY
  fi
}

assert_dist() {
  local arm="$1" got
  # A COUNT would not help here (the marker is unique), but check BOTH directions: the ablation
  # removes `labelTestsHold(element` from this function, which exists nowhere else in the bundle.
  got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
# ⚠️ A COMMENT CANNOT BE A DIST MARKER -- the bundler strips comments, so a 'ZZ-ABLATED' marker read
# as 0 in both arms (eighth anchor failure this session, and a new flavour). 'pred.truthTestProps'
# is no good either: it occurs 3 times, because the COMPILER builds that field. These two helpers
# are called ONLY from `satisfies`, exactly once each, so the ablation takes both to zero.
lab = t.count('labelTestsHold(')
typ = t.count('typedTestsHold(')
if lab == 1 and typ == 1: print('base')
elif lab == 0 and typ == 0: print('whereonly')
else: print(f'UNEXPECTED lab={lab} typ={typ}')
")
  if [ "$got" != "$arm" ]; then echo "ARM-ASSERT-FAILED $arm: saw [$got]"; return 1; fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base whereonly; do
    apply_arm "$arm"
    (cd "$R/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for s in hopfilter existssub; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 900 node runtime-profile-probe.mjs "$s" 1500 2>&1 | tail -1)
    done
  done
done
cp "$BASE" "$S"
(cd "$R/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored BASE"
