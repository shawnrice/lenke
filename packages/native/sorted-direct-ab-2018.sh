#!/bin/zsh
# Item 2018 — the sorted fast path's PRE/POST A/B across the WHOLE GQL screen.
#
# ⚠️⚠️ **THIS CHANGE IS IN THE GENERAL PROJECTION PATH, SO EVERY GQL QUERY GOES THROUGH IT.** That is
# a much wider blast radius than a rung: [[executor-edits-perturb]] records a new walk variant
# costing UNRELATED rows up to 16%, and item 1466 declined a 3.3x on that ground. A single
# nominated shape is not evidence here — the instrument has to be the whole screen.
#
# ⚠️ The screen already runs ONE CHILD PROCESS PER FAMILY, which is what keeps a family's figure out
# of the mix (item 762) and what stops an OOM or hang taking the run.
#
# ⚠️ ORDER-ALTERNATED, because the machine drifts and a one-way sweep attributes drift to the change.
#
#   PRE  = `sortedDirectRoute` forced to decline, so every sorted query takes the Map round-trip
#   POST = as shipped
#
# ⚠️ The arm is GREPPED before each build — CLAUDE.md's "assert each A/B arm IS the code it claims".
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
LIVE='  proj.orderBy.length > 0;'
DEAD='  proj.orderBy.length > 0 && false;'

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

# ⚠️ VERIFY THE TREE IS CLEAN AND COMPILES BEFORE TOUCHING IT. An interrupted earlier run leaves
# its arm in place, and the next run then measures that arm as if it were the baseline — or, as
# happened here, writes a syntactically invalid line and exits.
grep -F -q -- "$LIVE" "$SRC" || {
  print -- "REFUSING: the LIVE arm is not in $SRC — a previous run left its arm behind."
  grep -n 'proj.orderBy.length > 0' "$SRC" | tail -3
  exit 1
}
(cd "$ROOT" && timeout 600 bunx tsc --noEmit >/dev/null 2>&1) || {
  print -- "REFUSING: the tree does not typecheck before any arm was applied."
  exit 1
}

# ⚠️⚠️ **RESTORE ON ANY EXIT, NOT ONLY AT THE END — AND A KILL IS THE CASE THAT PROVES IT.** Item
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
