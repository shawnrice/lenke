#!/bin/zsh
# Item 2018 — a REDUCED control sweep for the sorted fast path.
#
# ⚠️⚠️ **THIS IS NARROWER THAN ITEM 2017'S AND SAYS SO.** The full four-round whole-screen A/B
# (`sorted-direct-ab-2018.sh`) was KILLED mid-round by the system's low-memory reaper, which also
# left the PRE arm in the tree — the reason every A/B script here now carries a `trap`. Rather than
# re-run the thing that was killed, this runs the families that (a) contain `ORDER BY` shapes the
# change can reach and (b) are CHEAP, one child process each, and it deliberately OMITS
# `multi-pattern`, whose 6.75M-row body is the memory cost.
#
# So: a regression check over five families and two rounds, not sixteen families over four. Read it
# as "nothing nearby moved against the change", not as item 2017's sweep.
#
# ⚠️ ONE CHILD PER FAMILY is the screen's own design (a family that OOMs or hangs must not take the
# run), and `FAMILY=` selects one.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
LIVE='  proj.orderBy.length > 0;'
DEAD='  proj.orderBy.length > 0 && false;'
FAMILIES=(chain-rows optional distinct projection neighbors)

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

# ⚠️ RESTORE ON ANY EXIT — see the note in `sorted-direct-ab-2018.sh`. A kill between the swap and
# the swap back leaves the tree silently on the wrong arm.
restore_live() {
  if ! grep -F -q -- "$LIVE" "$SRC"; then
    print -- "\n[trap] restoring the LIVE arm in $SRC"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $SRC by hand"
  fi
}
trap restore_live EXIT INT TERM

grep -F -q -- "$LIVE" "$SRC" || {
  print -- "REFUSING: the LIVE arm is not in $SRC — a previous run left its arm behind."
  exit 1
}

round() {
  set_arm "$2" "$3" || exit 1
  grep -F -q -- "$2" "$SRC" || { print -- "ARM NOT SET: $1"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || exit 1
  print -- "\n=== $1 ==="
  for f in "${FAMILIES[@]}"; do
    (cd "$ROOT/packages/native" && FAMILY=$f timeout 600 bun workload-perf-screen.mjs 2>&1 |
      grep -E "^$f" )
  done
}

round PRE "$DEAD" "$LIVE"
round POST "$LIVE" "$DEAD"
round 'PRE (2)' "$DEAD" "$LIVE"
round 'POST (2)' "$LIVE" "$DEAD"
print -- "\nrestored to LIVE"
