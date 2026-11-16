#!/bin/zsh
# Item 2027 — the optional rung's unconsumed COUNT terminal, PRE/POST.
#
# ⚠️ ONE SHAPE PER PROCESS (item 762), and load-bearing: this change REDISTRIBUTES call sites — five
# residual shapes leave the traverser pipeline — and item 762 prices a shared dispatch site at up to
# 1.56x in such a change's favour.
#
# ⚠️ CONTROLS: `values` alone (the rung this sits beside, which must not move), `values.dedupe`
# (which keeps its own narrower rung from item 1869), and `hop1: values` (a different rung
# entirely). Any movement there is drift or perturbation ([[executor-edits-perturb]]).
#
# ⚠️ THE DEAD ARM CARRIES A MARKER COMMENT so it greps to exactly one line — item 2020 lost a run to
# an ambiguous `return false;` and left the tree with the feature disabled.
#
# ⚠️ RESTORE ON ANY EXIT, and ROUND picks one arm per invocation so the sweep never has to be
# backgrounded (where it is reapable — item 2018).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/optional-hop-values.ts
LIVE="  return proj.kind === 'count' ?"
# ⚠️⚠️ A BLOCK COMMENT, NOT `//`. The line being replaced is a SINGLE-LINE ternary, so a `//` marker
# swallows the rest of it — the ternary loses its branches, the build fails, and the round prints
# NOTHING. Which is how it presented: four rounds, two of them silently empty. A marker that must sit
# mid-line has to be `/* … */`.
DEAD="  return /* AB-ARM-DEAD-2027 */ false ?"
# ⚠️ VERIFIED AGAINST THE SCREEN'S OWN SHAPE LIST. My first draft named 'scan: fold' and
# 'scan: dedupe values', neither of which exists there — the awk would have matched nothing and
# printed nothing, which reads as a missing row rather than a wrong name.
TARGETS=('optional: hop count')
# ⚠️ CONTROL CHOICE. scan:values is the rung this sits BESIDE and must not move. agg:values mean is
# REFUSED for byte-identity, so the gate provably cannot reach it. The hop rows are other rungs.
# ⚠️ AND agg:values min/max turn out to be ALREADY FAST in the PRE arm (6.24 / 5.89 against
# scan:values' 5.41) because fusableValuesAggregate gives them their own route — so they are
# controls in practice, not targets. The real targets are the two order rows.
# ⚠️ CONTROLS: the three scan-family siblings whose gates this rung sits beside (and which it must
# not shadow) that EXIST on this screen, plus two other rungs entirely. `where: neq filter` is the other `where` row on the
# screen and uses a PREDICATE where, which this rung refuses — so it is the control that proves the
# refusal is live rather than merely intended.
# ⚠️ `where: sub-traversal` is the THREE-STEP shape item 2025 fused and this item must not disturb;
# `scan: values` and the hop rows are other rungs.
# ⚠️ `optional: hop` is the SIBLING shape this rung already served and must not disturb; the rest are
# other rungs. `hop1: count` is the plain-hop count, served by countShortcut and unreachable here.
CONTROLS=('optional: hop' 'hop1: count' 'hop1: values' 'hop2: values')

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

# ⚠️ EXACT TRAILING-FIELD MATCH, not `grep -F`: the screen's `ONLY` uses `includes`, so a shorter
# shape name selects its longer siblings too and a substring grep reports the WRONG ROW's number
# (item 2020 measured a control that was secretly the target this way).
measure() {
  for shape in "$@"; do
    (cd "$ROOT/packages/native" && NODES=200000 ONLY="$shape" timeout 300 bun gremlin-workload-screen.mjs 2>&1 |
      awk -v want="$shape" '{ s = $0; sub(/^ *[0-9.]+ +[0-9]+ +/, "", s); if (s == want) print }' | head -1)
  done
}

case "${ROUND:-}" in
  PRE) set_arm "$DEAD" "$LIVE" || exit 1; grep -F -q -- "$DEAD" "$SRC" || exit 1 ;;
  POST) set_arm "$LIVE" "$DEAD" || exit 1; grep -F -q -- "$LIVE" "$SRC" || exit 1 ;;
  *) print -- "set ROUND=PRE | POST"; exit 1 ;;
esac

(cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || exit 1
print -- "=== $ROUND — shapes the residual path can reach ==="
measure "${TARGETS[@]}"
print -- "=== $ROUND — controls ==="
measure "${CONTROLS[@]}"
