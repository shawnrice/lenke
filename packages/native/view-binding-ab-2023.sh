#!/bin/zsh
# Item 2023 — the no-copy binding VIEW, in situ, with the ITERATING consumers as controls.
#
# **THE WHOLE-SCREEN SWEEP CANNOT SHOW THIS WIN, and that is a property of the screen rather
# than of the change.** The merge fires only on an UNCORRELATED product — a comma pattern of
# independent legs, or a second MATCH clause sharing no names — and the one screen family that has
# those is `multi-pattern`, which the screen caps at its 15 s BUDGET ("1/100 queries in 15000 ms") in
# both arms. A budget-limited row reports the budget, not the time, so its PRE/POST ratio is ~1 by
# construction. The other 15 families are CONTROLS and read flat, which is what they are for.
#
# So the target is measured on `crossproduct-sort-2017.mjs`, which drives the same shape without a
# budget, and the screen's flat families are reported alongside as the controls.
#
# ONE ARM PER PROCESS, order-alternated, trap-restored — items 762, 2018, 2020.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/clauses.ts
LIVE='          yield mergeBinding(b, t);'
DEAD='          yield viewBinding(b, t); // AB-ARM-VIEW-2023'

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

restore_live() {
  if ! grep -F -q -- "$LIVE" "$SRC" && ! grep -F -q -- "$DEAD" "$SRC"; then
    print -- "\n[trap] arm is NEITHER — restoring LIVE in $SRC"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $SRC by hand"
  fi
}
trap restore_live EXIT INT TERM

round() {
  set_arm "$2" "$3" || exit 1
  grep -F -q -- "$2" "$SRC" || { print -- "ARM NOT SET: $1"; exit 1; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || exit 1
  print -- "=== $1 ==="
  for arm in product star distinct ordered; do
    (cd "$ROOT/packages/native" && ARM=$arm timeout 300 systemd-run --user --scope -q \
      -p MemoryMax=16G -p MemorySwapMax=0 bun crossproduct-sort-2017.mjs 2>&1 | tail -1)
  done
}

# NAMED `COPY` AND `VIEW`, NOT `PRE`/`POST`, AND THAT IS NOT CosMETIC: with PRE/POST the first run
# of this script installed the VIEW under the label "PRE", because `round PRE "$DEAD" …` sets the
# DEAD arm — and the DEAD arm here IS the experiment. Reading 186.7 ms as the baseline would have
# inverted the whole conclusion. An A/B whose arms are not named for WHAT THEY ARE invites exactly
# that.
case "${ROUND:-}" in
  COPY) round COPY "$LIVE" "$DEAD" ;;
  VIEW) round VIEW "$DEAD" "$LIVE" ;;
  # RUN THIS LAST, OR THE TREE KEEPS WHICHEVER ARM RAN. The trap above only acts when the arm is
  # NEITHER — a round that deliberately installed VIEW leaves VIEW, which is correct for the sweep
  # and wrong for the tree. Ending on VIEW and then deleting the view function left the call site
  # referring to a name that no longer existed (caught by tsc, but only after the fact).
  RESTORE) set_arm "$LIVE" "$DEAD" && print -- "restored to COPY" ;;
  *) print -- "set ROUND=COPY | VIEW | RESTORE"; exit 1 ;;
esac
