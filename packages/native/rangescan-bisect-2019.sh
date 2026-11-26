#!/bin/zsh
# Item 2019 — WHICH HALF OF ITEM 2018 COST `range-scan` 1.45x?
#
# **THE OWED SWEEP FOUND A REGRESSION THE REDUCED ONE MISSED.** Item 2018 shipped on five cheap
# families because its four-round whole-screen A/B had been killed; the owed sweep then read
# `range-scan` at **0.69x — PRE 32.4/33.5 against POST 49.1/47.0, non-overlapping across both
# rounds**, while `union`'s 0.95x is noise (its ranges overlap). `range-scan` was not in the five.
#
# Item 2018 made TWO changes to `projection.ts` and either could be the cause:
#
#   A  BEFORE      `git show HEAD~1` — neither change
#   B  EXTRACTION  `keyedComparator` hoisted to module scope, the new path GATED OFF. One comparator
#                  body now serves two call sites, which can make it polymorphic where two inline
#                  copies were monomorphic ([[ts-closure-size-is-load-bearing]]).
#   C  FULL        as shipped
#
# ONE FAMILY PER PROCESS, which the screen already does with `FAMILY=`; three rounds per arm,
# order-alternated A B C C B A, because a one-way sweep attributes machine drift to the arm.
#
# RESTORE ON ANY EXIT — item 2018's kill left an arm in the tree; see that script's note.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/projection.ts
SCRATCH=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad
BEFORE=$SCRATCH/proj-before-2018.ts
FULL=$SCRATCH/proj-full-2018.ts
GATED=$SCRATCH/proj-gated-2018.ts
FAMILY=${FAMILY:-range-scan}

# Build the three arms ONCE, from the current (FULL) tree, so each is byte-exact and reusable.
if [[ ! -f "$FULL" ]]; then
  cp "$SRC" "$FULL" || exit 1
  python3 - "$FULL" "$GATED" <<'PY'
import io, sys
s = io.open(sys.argv[1], encoding='utf-8').read()
old = '  proj.orderBy.length > 0;'
assert s.count(old) == 1
io.open(sys.argv[2], 'w', encoding='utf-8').write(
    s.replace(old, '  proj.orderBy.length > 0 &&\n  false;'))
PY
fi

restore_full() { cp "$FULL" "$SRC"; }
trap restore_full EXIT INT TERM

run_arm() {
  cp "$2" "$SRC" || exit 1
  # ASSERT THE ARM IS THE CODE IT CLAIMS: a `cp` that silently did nothing leaves the previous
  # arm and the reading belongs to it (CLAUDE.md).
  cmp -s "$SRC" "$2" || { print -- "ARM NOT SET: $1"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || exit 1
  local ms
  ms=$( (cd "$ROOT/packages/native" && FAMILY=$FAMILY timeout 600 bun workload-perf-screen.mjs 2>&1 |
    grep -E "^$FAMILY" | awk '{print $2}') )
  print -- "  $1  $ms ms"
}

print -- "# bisecting FAMILY=$FAMILY  (A=before, B=extraction only, C=full)"

for order in "A B C" "C B A"; do
  print -- "\n=== pass: $order ==="
  for a in ${=order}; do
    case $a in
      A) run_arm A "$BEFORE" ;;
      B) run_arm B "$GATED" ;;
      C) run_arm C "$FULL" ;;
    esac
  done
done

print -- "\nrestoring FULL"
