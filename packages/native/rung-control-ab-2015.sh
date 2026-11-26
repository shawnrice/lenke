#!/bin/zsh
# Item 2015 — does ADDING the `branch` rung cost the shapes it does not claim?
#
# [[executor-edits-perturb]]: a new walk variant has cost UNRELATED rows up to 16% (items
# 1413/1415/1440/1442/1462), and item 1466 DECLINED a 3.3x on that basis. A new rung in
# `fusedProjectedValues` adds one `??` test per plan and one more module to the inlining budget, so
# the question is empirical rather than obvious.
#
# ONE SHAPE PER PROCESS (item 762): with several shapes in one run the shared dispatch site is
# polymorphic and the figure belongs to the mix. So each arm is its own `bun` invocation.
#
# THE TARGET IS MEASURED ALONGSIDE THE CONTROLS, in the same loop, so a machine-wide drift moves
# all of them and shows up as a target that did not move either.
#
#   PRE  = the rung made to DECLINE  (`(false ? branchValueHop(...) : undefined)`)
#   POST = the rung as shipped
#
# NOT `undefined ??` IN FRONT — that evaluates the call and disables nothing (the trap item 2015
# found in `battery-2014.mjs`'s header). The arm is ASSERTED to be the code it claims below, which is
# CLAUDE.md's rule and the reason this script greps before each round.
set -u

ROOT=/home/shawn/projects/pl-graph
IDX=$ROOT/packages/gremlin/src/executor/index.ts
LIVE='      branchValueHop(effective, graph) ??'
DEAD='      (false ? branchValueHop(effective, graph) : undefined) ??'
ARMS=(branchTwo hop hopIn optional coalesce chooseConst chooseTwoArm)

measure() {
  local label=$1

  print -- "\n=== $label ==="
  for arm in "${ARMS[@]}"; do
    ARM=$arm timeout 900 bun "$ROOT/packages/native/coalesce-vs-optional-1990.mjs" 2>&1 |
      tail -1
  done
}

set_arm() {
  local want=$1 other=$2

  python3 - "$IDX" "$other" "$want" <<'PY'
import io, sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
if s.count(new) == 1 and s.count(old) == 0:
    print('already set'); raise SystemExit(0)
assert s.count(old) == 1, f'anchor count {s.count(old)}'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
print('set')
PY
}

# ASSERT THE ARM IS THE CODE IT CLAIMS, BEFORE BUILDING — CLAUDE.md's rule. A `cp` or `sed` that
# silently did nothing leaves the previous arm in place and the "after" reading is then the "before"
# code: a null that looks like a result.
round() {
  local label=$1 want=$2 other=$3

  set_arm "$want" "$other" || exit 1
  grep -F -q -- "$want" "$IDX" || { print -- "ARM NOT SET: $label"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || exit 1
  measure "$label"
}

# **RESTORE ON ANY EXIT, NOT ONLY AT THE END — AND A KILL IS THE CASE THAT PROVES IT.** Item
# 2018's run of this script was killed mid-round by the system's low-memory reaper and left the PRE
# arm (`&& false`) in `projection.ts`: the fast path silently disabled, the tree still compiling, and
# nothing to notice it but a `git diff`. The mutation harnesses restore in a loop and re-verify at
# the end; an A/B that swaps arms needs a `trap`, because it can die between the swap and the swap
# back. SIGTERM, SIGINT and ordinary EXIT all land here.
restore_live() {
  # THIS SCRIPT'S SOURCE VARIABLE IS $IDX, NOT $SRC — under `set -u` a trap naming the wrong one
  # dies on an unbound variable at exactly the moment it is needed.
  if ! grep -F -q -- "$LIVE" "$IDX"; then
    print -- "\n[trap] restoring the LIVE arm in $IDX"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $IDX by hand"
  fi
}
trap restore_live EXIT INT TERM

round PRE "$DEAD" "$LIVE"
round POST "$LIVE" "$DEAD"
# Order-alternated second pass: the machine drifts, and a one-way sweep attributes that drift to the
# change (CLAUDE.md's "match sample counts on both sides").
round 'POST (2)' "$LIVE" "$DEAD"
round 'PRE (2)' "$DEAD" "$LIVE"
round 'RESTORED' "$LIVE" "$DEAD"
print -- "\nrestored to LIVE"
