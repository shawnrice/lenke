#!/bin/zsh
# Item 2032 — what is the CEILING for compiling the two-hop rung's start predicate DIRECTLY, instead
# of `binding.set(startVar, a)` + `pred.fn(env)` reading it straight back out of the Map?
#
# The profile's two remaining unpriced frames are `twoHopFilteredCsrCount.accept` (15.3%) and
# `variable.variable in compileExpr` (14.2%) — the latter is literally `(env) => env.binding.get(name)`.
# That round-trip was closed TWICE elsewhere (items 224/230 for predicates, `detectNodeProjection` for
# projections) on a byte-identical-by-construction argument: same function, same element. This rung
# never got it, and `predReadsOnlyStart` is ALREADY computed at its gate.
#
# THE ABLATE ARM IS NOT SHIPPABLE: it HARDCODES the probe fixture's own predicate
# (`a.k === 5`), so it is an oracle for "what would a direct closure cost", nothing more. Shipping
# needs a compiler path that DETECTS this predicate shape.
#
# ANSWER-EQUIVALENCE IS WHAT MAKES IT A CEILING, and the probe enforces it: every shape asserts its
# answer against item 2030's independent oracle, so a hardcode that does not match the real predicate
# fails LOUDLY instead of quietly measuring a different query.
#
# BOTH MODES, because item 2031's nomination died on exactly this: a 13.6% ceiling on the
# homogeneous fixture was 0% once ONE off-label vertex existed. A ceiling measured in one mode is not
# a ceiling. This lever is NOT vacuity-gated, so it SHOULD survive MIXED=1 — which is a prediction the
# run can falsify.
#
# RESTORE ON ANY EXIT, and RESTORE REBUILDS — item 2031 read the ablated dist under the control's
# name because `ROUND=RESTORE` returned before `nx build` and `@lenke/*` resolve to DIST.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/shortcuts.ts
PRISTINE=$ROOT/crates/lenke-engine/target/shortcuts.pristine.2032.ts
SHAPES=(join hopfilter point hopall)

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || print -- "[trap] RESTORED SOURCE BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE IS NOT PRISTINE at start — refusing"; exit 1; }

ANCHOR='              return asTruth(pred.fn(env)) === true;'
c=$(grep -cF -- "$ANCHOR" "$SRC")
[[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c)"; exit 1; }

ablate() {
  cp "$PRISTINE" "$SRC" || exit 1
  # The direct read: no Map write, no `env`, no `binding.get` — `propOf` on the element the loop holds.
  sed -i "s@              return asTruth(pred.fn(env)) === true;@              return (a.properties?.k ?? undefined) === 5;@" "$SRC" || exit 1
  grep -cF 'a.properties?.k ?? undefined' "$SRC" | grep -q '^1$' || { print -- "ABLATE ARM NOT SET"; exit 1; }
}

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    ABLATE) ablate ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | ABLATE | RESTORE"; exit 1 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 (MIXED=${MIXED:-0}) ==="
  for s in "${SHAPES[@]}"; do
    (cd "$ROOT/packages/native" && NODES=20000 FANOUT=3 timeout 900 bun runtime-profile-probe.mjs "$s" 2>&1 | tail -1)
  done
}

round "${ROUND:-}"
