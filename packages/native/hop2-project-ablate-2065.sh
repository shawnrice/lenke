#!/bin/zsh
# Item 2065 — the ABLATION CEILING for the two-hop walk's projection.
#
# ⚠️⚠️ THIS IS A DELETION TEST, NOT A CANDIDATE CHANGE. Item 2064 nominated `propOf` + `get properties`
# at 27% of the two-hop walk's profile, and this file's own history says that is not a win: item 2030
# nominated 20.9% in this same rung's label tests and item 2031 ablated it to a 13.6% CEILING and 0%
# REACHABLE. [[frame-attribution-trap]] also applies — `get properties` is a GETTER frame, which is
# attribution until a deletion test with a CONTROL says otherwise.
#
# ⚠️⚠️ **THE ABLATED BUILD RETURNS WRONG ROWS AND MUST NEVER BE COMMITTED.** `ROW_CEILING` pushes a
# hoisted constant, so the row COUNT is unchanged (which is what makes the timing comparable) while
# every row's CONTENT is wrong. The trap restores; the start-of-run check refuses a dirty tree.
#
# TWO CEILINGS, because they bound different changes:
#   PROJECT  — `projectRow` alone removed. Bounds "specialize the projection to a direct read".
#   BOTH     — also the per-row `binding.set`. Bounds "specialize AND skip the binding", which a
#              direct read of `c.k` would not need. A LOOSER bound, and stated as such.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/hop2-projection.ts
PRISTINE=$ROOT/crates/lenke-engine/target/hop2-projection.pristine.2065.ts

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() {
  cp "$PRISTINE" "$SRC" || { print -- "[trap] COULD NOT RESTORE"; return; }
  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || print -- "[trap] RESTORED BUT BUILD FAILED"
}
trap restore_live EXIT INT TERM

cmp -s "$SRC" "$PRISTINE" || { print -- "TREE NOT PRISTINE at start — refusing"; exit 1; }

PROJ="          out.push(projectRow(projection, binding, params, graph));"
BIND="            binding.set(v2, c);"

for a in "$PROJ" "$BIND"; do
  c=$(grep -cF -- "$a" "$SRC")
  [[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c): $a"; exit 1; }
done

round() {
  cp "$PRISTINE" "$SRC" || exit 1

  case "$1" in
    LIVE) cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    PROJECT)
      sed -i "s@          out.push(projectRow(projection, binding, params, graph));@          out.push(ROW_CEILING); // ABLATED 2065@" "$SRC" || exit 1
      grep -cF "// ABLATED 2065" "$SRC" | grep -q '^1$' || { print -- "PROJECT ABLATION NOT SET"; exit 1; }
      ;;
    BOTH)
      sed -i "s@          out.push(projectRow(projection, binding, params, graph));@          out.push(ROW_CEILING); // ABLATED 2065@" "$SRC" || exit 1
      sed -i "s@            binding.set(v2, c);@            void c; // ABLATED 2065 binding@" "$SRC" || exit 1
      grep -cF "// ABLATED 2065" "$SRC" | grep -q '^2$' || { print -- "BOTH ABLATION NOT SET"; exit 1; }
      ;;
    RESTORE) restore_live; print -- "restored + rebuilt"; return 0 ;;
    *) print -- "set ROUND=LIVE | PROJECT | BOTH | RESTORE"; exit 1 ;;
  esac

  # The hoisted constant the ablated arms push. Declared at module scope so the loop allocates none —
  # an ablation that allocated per row would measure its own cost.
  if [[ "$1" != "LIVE" ]]; then
    sed -i "s@^const walk = (@const ROW_CEILING = Object.freeze({ k: 0 });\n\nconst walk = (@" "$SRC" || exit 1
    grep -cF "const ROW_CEILING = Object.freeze" "$SRC" | grep -q '^1$' || { print -- "ROW_CEILING NOT DECLARED"; exit 1; }
  fi

  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="

  # ⚠️ THE TARGET PLUS A CONTROL THE ABLATION CANNOT REACH. `hoprows` is the ONE-hop rung in a
  # different file, so it must not move; if it does, the reading is the machine, not the ablation.
  for shape in hop2rows hop2distinct hoprows; do
    (cd "$ROOT/packages/native" && NODES=200000 timeout 900 bun runtime-profile-probe.mjs "$shape" "${REPS:-7}" 2>&1 | grep -oE '"shape".*')
  done
}

round "${ROUND:-}"
