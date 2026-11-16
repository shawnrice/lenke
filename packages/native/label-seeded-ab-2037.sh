#!/bin/zsh
# Item 2037 — the label-seeded `values` fusion, LIVE against a KILLED rung.
#
# ⚠️ THE KILL SWITCH IS `(false ? f(...) : undefined)`, NEVER `undefined ?? f(...)` — the latter
# EVALUATES the call and compares the route against itself ([[disabling-a-rung-for-an-oracle]]).
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE (LIVE/KILLED), not PRE/POST (item 2023), and ⚠️ ONE MODE PER
# PROCESS — building both graphs in one process gave this probe's own CONTROL a +/-30% band across
# six runs (item 2037's instrument fix).
#
# ⚠️ RESTORE REBUILDS: `@lenke/*` resolve to dist, so a restored SOURCE with a stale BUILD measures
# the experiment under the control's name (item 2031 did exactly that).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gremlin/src/executor/index.ts
PRISTINE=$ROOT/crates/lenke-engine/target/gremlin-index.pristine.2037.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR='      : labelSeededValuesFusion(seeded.stream, seeded.steps, ctx.tracksPath);'
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

kill_rung() {
  cp "$PRISTINE" "$SRC" || exit 1
  sed -i "s@: labelSeededValuesFusion(seeded.stream, seeded.steps, ctx.tracksPath);@: (false ? labelSeededValuesFusion(seeded.stream, seeded.steps, ctx.tracksPath) : undefined);@" "$SRC" || exit 1
  grep -cF 'false ? labelSeededValuesFusion' "$SRC" | grep -q '^1$' || { print -- "KILLED ARM NOT SET"; exit 1; }
}

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    KILLED) kill_rung ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | KILLED | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gremlin >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  for m in vacuous mixed; do
    (cd "$ROOT/packages/native" && MODE=$m N=200000 OPS=20 REPS=9 timeout 900 bun gremlin-label-cliff-2036.mjs 2>&1 |
      grep -E "hasLabel values|hasLabel bare|values \(control\)|count \(control\)")
  done

  # ⚠️ THE WIDE SCREEN, because an executor edit costs UNRELATED rows up to 16%
  # ([[executor-edits-perturb]]) and `run` is the most central function in the engine.
  (cd "$ROOT/packages/native" && timeout 900 bun gremlin-workload-screen.mjs 2>&1 | grep -E "^ " )
}

round "${ROUND:-}"
