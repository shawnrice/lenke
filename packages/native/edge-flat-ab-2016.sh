#!/bin/zsh
# Item 2016 — the flat edge array's PRE/POST A/B, with controls.
#
# ONE SHAPE PER PROCESS (item 762), so each arm is its own `bun` invocation and the figure never
# belongs to a mix of shapes sharing a dispatch site.
#
# ORDER-ALTERNATED, because the machine drifts and a one-way sweep attributes that drift to the
# change (CLAUDE.md: "match sample counts on both sides").
#
# CONTROLS ARE MANDATORY FOR A NEW WALK — [[executor-edits-perturb]], where a new walk variant
# cost UNRELATED rows up to 16% and item 1466 declined a 3.3x on exactly that ground. Here the
# controls are the shapes that take the VERTEX CSR (`hop`, `unfiltered`), because the `kind`
# namespace change in `second-ask.ts` is on their path too: if this rung accidentally armed their
# builds, their FIRST ask would get slower, which is what the per-rep series shows.
#
#   PRE  = the flat arm made to DECLINE  (`spec.flat` read as `false`)
#   POST = as shipped
#
# NOT `undefined ??` IN FRONT of anything — see `disabling-a-rung-for-an-oracle` in memory and
# `battery-2014.mjs`'s corrected header. The arm is GREPPED before each build.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/edge-filtered-hop-values.ts
LIVE='    if (spec.flat) {'
DEAD='    if (spec.flat && false) {'
ARMS=(filtered unfiltered hop)

measure() {
  print -- "\n=== $1 ==="
  for arm in "${ARMS[@]}"; do
    SHAPE=$arm timeout 900 bun "$ROOT/packages/native/edge-filter-series-2016.mjs" 2>&1 | tail -2
  done
}

set_arm() {
  python3 - "$SRC" "$2" "$1" <<'PY'
import io, sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
if s.count(new) == 1 and s.count(old) == 0:
    raise SystemExit(0)
assert s.count(old) == 1, f'anchor count {s.count(old)}'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
PY
}

round() {
  set_arm "$2" "$3" || exit 1
  # ASSERT THE ARM IS THE CODE IT CLAIMS BEFORE BUILDING — CLAUDE.md's rule. A patch that
  # silently did nothing leaves the previous arm in place and the "after" reading is the "before"
  # code: a null that looks like a result.
  grep -F -q -- "$2" "$SRC" || { print -- "ARM NOT SET: $1"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || exit 1
  measure "$1"
}

# **RESTORE ON ANY EXIT, NOT ONLY AT THE END — AND A KILL IS THE CASE THAT PROVES IT.** Item
# 2018's run of this script was killed mid-round by the system's low-memory reaper and left the PRE
# arm (`&& false`) in `projection.ts`: the fast path silently disabled, the tree still compiling, and
# nothing to notice it but a `git diff`. The mutation harnesses restore in a loop and re-verify at
# the end; an A/B that swaps arms needs a `trap`, because it can die between the swap and the swap
# back. SIGTERM, SIGINT and ordinary EXIT all land here.
restore_live() {
  if ! grep -F -q -- "$LIVE" "$SRC"; then
    print -- "\n[trap] restoring the LIVE arm in $SRC"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $SRC by hand"
  fi
}
trap restore_live EXIT INT TERM

round PRE "$DEAD" "$LIVE"
round POST "$LIVE" "$DEAD"
round 'POST (2)' "$LIVE" "$DEAD"
round 'PRE (2)' "$DEAD" "$LIVE"
round RESTORED "$LIVE" "$DEAD"
print -- "\nrestored to LIVE"
