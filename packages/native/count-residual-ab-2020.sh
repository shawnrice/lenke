#!/bin/zsh
# Item 2020 — the fused `count()` residual's PRE/POST A/B.
#
# ⚠️ ONE SHAPE PER PROCESS (item 762), and here that is not boilerplate: this change REDISTRIBUTES
# call sites — count shapes leave the generic traverser route — and item 762 records that a shared
# dispatch site flatters exactly that kind of change by up to 1.56x on a control.
#
# ⚠️ CONTROLS ARE NON-COUNT SHAPES the gate cannot reach, so any movement in them is drift or
# perturbation ([[executor-edits-perturb]]).
#
# ⚠️ RESTORE ON ANY EXIT — item 2018's kill left an arm in the tree; see that script's note. And
# ROUND picks one arm per invocation, because a whole sweep exceeds the 600 s foreground cap and a
# backgrounded one is reapable.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/aggregation.ts
LIVE="  return !('scope' in step) || step.scope === undefined || step.scope === 'global';"
# ⚠️⚠️ **THE DEAD ARM MUST BE UNAMBIGUOUS, AND `  return false;` IS NOT.** That string appears many
# times in `aggregation.ts`, so (a) `set_arm`'s "already set" check matched a line it did not write
# and (b) the restore guard saw "a dead arm present" and did nothing — leaving the tree with the
# count residual DISABLED after the first run. Third time an ambiguous arm string has cost
# something this session; a marker comment makes it greppable to exactly one line.
DEAD='  return false; // AB-ARM-DEAD-2020'
COUNTS=('edge: outE.has(w).inV.count' 'edge: outE.has(w).count' 'hop1: count' 'hop1: dedupe count')
CONTROLS=('edge: outE.has(w).inV' 'hop1: values' 'hop2: values')

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
    print -- "\n[trap] arm is NEITHER live nor dead — restoring LIVE in $SRC"
    set_arm "$LIVE" "$DEAD" || print -- "[trap] COULD NOT RESTORE — fix $SRC by hand"
  fi
}
trap restore_live EXIT INT TERM

if ! grep -F -q -- "$LIVE" "$SRC" && ! grep -F -q -- "$DEAD" "$SRC"; then
  print -- "REFUSING: $SRC holds neither arm — a previous run died mid-swap."
  exit 1
fi

# ⚠️⚠️ **EXACT TRAILING-FIELD MATCH, NOT `grep -F`.** The screen's `ONLY` filter uses `includes`, so
# `ONLY='edge: outE.has(w).inV'` selects BOTH that row AND `…inV.count` — and a `grep -F` for the
# shorter name then picks whichever prints first. The first run of this script reported the COUNT
# row's 11.34 ms as the control's reading, which is the exact "a control that is secretly the target"
# trap. The shape is the line's trailing text, so match it there.
measure() {
  for shape in "$@"; do
    (cd "$ROOT/packages/native" && NODES=50000 ONLY="$shape" timeout 300 bun gremlin-workload-screen.mjs 2>&1 |
      awk -v want="$shape" '{ s = $0; sub(/^ *[0-9.]+ +[0-9]+ +/, "", s); if (s == want) print }' | head -1)
  done
}

case "${ROUND:-}" in
  PRE) set_arm "$DEAD" "$LIVE" || exit 1; grep -F -q -- "$DEAD" "$SRC" || exit 1 ;;
  POST) set_arm "$LIVE" "$DEAD" || exit 1; grep -F -q -- "$LIVE" "$SRC" || exit 1 ;;
  *) print -- "set ROUND=PRE | POST"; exit 1 ;;
esac

(cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || exit 1
print -- "=== $ROUND — count shapes ==="
measure "${COUNTS[@]}"
print -- "=== $ROUND — controls (the gate cannot reach these) ==="
measure "${CONTROLS[@]}"
