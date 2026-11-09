#!/usr/bin/env bash
# Item 1745: `extend`'s object literal ends with a SPREAD on the common no-sack path.
#
#   base   ...(prev.sack === undefined ? {} : { sack: prev.sack })
#   fixed  sack: prev.sack
#
# EXACTLY EQUIVALENT, verified by reading every consumer: the only one is `sack.ts`'s
# `t.sack === undefined ? cfg.value : t.sack`, which tests the VALUE, not key presence. Nothing in
# the repo does `'sack' in t` or `Object.keys` over a traverser. So an explicit `sack: undefined`
# cannot be observed -- while a spread in an object literal denies V8 a fixed hidden class for the
# whole literal, and the base also allocates an empty `{}` on every no-sack extend.
#
# ⚠️ The comment at the site claims the no-sack path has "no cost". That is a claim about cost, and
# this measures it rather than trusting it.
#
# CONTROL: `V().count()` never calls `extend` (the source uses `startTraverser`), so it must not move.
set -u
R=/home/shawn/projects/pl-graph
S=$R/packages/gremlin/src/executor/runtime.ts
BASE=$R/crates/lenke-engine/target/pristine-1745-base.ts
D=$R/packages/gremlin/dist/esm/index.mjs

apply_arm() {
  cp "$BASE" "$S" || exit 90
  if [ "$1" = fixed ]; then
    python3 - "$S" <<'PY' || exit 91
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = """  tags: prev.tags,
  // Propagate the sack (split-on-branch = clone). Only defined once a sack write
  // has run, so the common no-sack path carries `undefined` (no cost).
  ...(prev.sack === undefined ? {} : { sack: prev.sack }),
});"""
new = """  tags: prev.tags,
  sack: prev.sack,
});"""
assert t.count(old) == 1, f"anchor matched {t.count(old)} times, expected 1"
open(p, 'w', encoding='utf-8').write(t.replace(old, new))
PY
  fi
}

assert_dist() {
  local arm="$1" got
  # A COUNT-free discriminator is fine here because the spread text is unique to base (item 1744's
  # rule: presence only discriminates when the text exists in exactly one arm -- checked both ways).
  got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
spread = 'prev.sack === void 0' in t or 'prev.sack === undefined' in t
print('base' if spread else 'fixed')
")
  if [ "$got" != "$arm" ]; then echo "ARM-ASSERT-FAILED $arm: saw [$got]"; return 1; fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2 3; do
  for arm in base fixed; do
    apply_arm "$arm"
    (cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for shape in coalesced hopcount3 folded control; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 900 node runtime-profile-gremlin-probe.mjs "$shape" 300 2>&1 | tail -1)
    done
  done
done
cp "$BASE" "$S"
(cd "$R/packages/gremlin" && bun run build > /dev/null 2>&1)
echo "restored BASE"
