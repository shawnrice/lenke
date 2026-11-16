#!/bin/zsh
# Item 2022 — the merge's PRE/POST on the shape that actually exercises it.
#
# ⚠️⚠️ **THE WHOLE-SCREEN SWEEP CANNOT SHOW THIS WIN, and that is a property of the screen rather
# than of the change.** The merge fires only on an UNCORRELATED product — a comma pattern of
# independent legs, or a second MATCH clause sharing no names — and the one screen family that has
# those is `multi-pattern`, which the screen caps at its 15 s BUDGET ("1/100 queries in 15000 ms") in
# both arms. A budget-limited row reports the budget, not the time, so its PRE/POST ratio is ~1 by
# construction. The other 15 families are CONTROLS and read flat, which is what they are for.
#
# So the target is measured on `crossproduct-sort-2017.mjs`, which drives the same shape without a
# budget, and the screen's flat families are reported alongside as the controls.
#
# ⚠️ ONE ARM PER PROCESS, order-alternated, trap-restored — items 762, 2018, 2020.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/clauses.ts
LIVE='  const merged = new Map(outer);'
DEAD='  const merged = new Map([...outer, ...inner]); // AB-ARM-DEAD-2022'

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
  for arm in product ordered; do
    (cd "$ROOT/packages/native" && ARM=$arm timeout 300 systemd-run --user --scope -q \
      -p MemoryMax=16G -p MemorySwapMax=0 bun crossproduct-sort-2017.mjs 2>&1 | tail -1)
  done
}

case "${ROUND:-}" in
  PRE) round PRE "$DEAD" "$LIVE" ;;
  POST) round POST "$LIVE" "$DEAD" ;;
  *) print -- "set ROUND=PRE | POST"; exit 1 ;;
esac
