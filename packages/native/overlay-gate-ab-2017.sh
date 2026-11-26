#!/bin/zsh
# Item 2017 — the sort-overlay gate's PRE/POST A/B across the WHOLE GQL screen.
#
# **THIS CHANGE IS IN THE GENERAL PROJECTION PATH, SO EVERY GQL QUERY GOES THROUGH IT.** That is
# a much wider blast radius than a rung: [[executor-edits-perturb]] records a new walk variant
# costing UNRELATED rows up to 16%, and item 1466 declined a 3.3x on that ground. A single
# nominated shape is not evidence here — the instrument has to be the whole screen.
#
# The screen already runs ONE CHILD PROCESS PER FAMILY, which is what keeps a family's figure out
# of the mix (item 762) and what stops an OOM or hang taking the run.
#
# ORDER-ALTERNATED, because the machine drifts and a one-way sweep attributes drift to the change.
#
#   PRE  = the overlay built unconditionally (as before item 2017)
#   POST = gated on `proj.orderNeedsOutput`
#
# The arm is GREPPED before each build — CLAUDE.md's "assert each A/B arm IS the code it claims".
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
LIVE='        orderBy.length > 0 && proj.orderNeedsOutput ? new Map([...b, ...projected]) : b;'
DEAD='        orderBy.length > 0 ? new Map([...b, ...projected]) : b;'

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
  grep -F -q -- "$2" "$SRC" || { print -- "ARM NOT SET: $1"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || exit 1
  print -- "\n=== $1 ==="
  (cd "$ROOT/packages/native" && timeout 2400 bun workload-perf-screen.mjs 2>&1 |
    grep -E '^[a-z]' | grep -vE '^(family|vertices)')
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
round 'PRE (2)' "$DEAD" "$LIVE"
round 'POST (2)' "$LIVE" "$DEAD"
print -- "\nrestored to LIVE (gated)"
