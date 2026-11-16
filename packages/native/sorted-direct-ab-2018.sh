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
# ⚠️ EITHER ARM IS ACCEPTABLE AT START (an alternating round finds the previous round's), but a tree
# holding NEITHER means a run died mid-swap and the baseline cannot be trusted.
if ! grep -F -q -- "$LIVE" "$SRC" && ! grep -F -q -- "$DEAD" "$SRC"; then
  print -- "REFUSING: $SRC holds neither arm — a previous run died mid-swap."
  grep -n 'proj.orderBy.length > 0' "$SRC" | tail -3
  exit 1
fi
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
  # ⚠️ A ROUND LEAVES ITS OWN ARM IN PLACE ON PURPOSE so the next call can alternate, so the trap
  # must only act when the arm is NEITHER — a round that died part-way through its own swap.
  if ! grep -F -q -- "$LIVE" "$SRC" && ! grep -F -q -- "$DEAD" "$SRC"; then
    print -- "\n[trap] arm is NEITHER live nor dead — restoring LIVE in $SRC"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $SRC by hand"
  fi
}
trap restore_live EXIT INT TERM

# ⚠️⚠️ **ONE ROUND PER INVOCATION, BECAUSE THE FOUR-ROUND FORM WAS KILLED.** The whole sweep exceeds
# the harness's 600 s foreground cap, so it ran as a BACKGROUND shell — where Claude Code's
# low-memory reaper stopped it mid-round, leaving the DEAD arm in the tree (the `trap` above is what
# now prevents that). A single round fits the foreground cap, so the sweep is four separate calls:
#
#     ROUND=PRE  zsh sorted-direct-ab-2018.sh
#     ROUND=POST zsh sorted-direct-ab-2018.sh
#     ROUND=PRE  zsh sorted-direct-ab-2018.sh    # order-alternated second pass
#     ROUND=POST zsh sorted-direct-ab-2018.sh
#     ROUND=RESTORE zsh sorted-direct-ab-2018.sh # only if the last call was not POST
#
# ⚠️ EACH CALL LEAVES THE TREE ON *ITS* ARM so the next can alternate, which is why the trap below
# only acts when the arm is NEITHER cleanly LIVE nor cleanly DEAD — i.e. a round that died part-way.
case "${ROUND:-}" in
  PRE) round PRE "$DEAD" "$LIVE" ;;
  POST) round POST "$LIVE" "$DEAD" ;;
  RESTORE) set_arm "$LIVE" "$DEAD" && print -- "restored to LIVE" ;;
  *) print -- "set ROUND=PRE | POST | RESTORE"; exit 1 ;;
esac
