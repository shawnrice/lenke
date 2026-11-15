#!/bin/zsh
# Item 1918 — interleaved PRE/POST A/B for fusing `sum`/`mean` into the projected residual.
#
# WHY INTERLEAVED. The first POST reading showed the two UNTOUCHED arms moving ~12-14% in the
# change's favour (`min` 86.44 -> 74.25, `strmin` 233.05 -> 205.91) while the targets moved ~133%.
# CLAUDE.md: a control moving in the change's favour is the giveaway for a redistribution artefact,
# and single-run against single-run has not survived repetition here. The targets' win dwarfs the
# drift, which is exactly why it has to be measured rather than assumed.
#
# ⚠️ EACH ARM ASSERTS IT IS THE CODE IT CLAIMS BEFORE MEASURING — `foldProjectedNumeric` must appear
# in `aggregation.ts` in POST and never in PRE.
set -e
set -u

ROOT=/home/shawn/projects/pl-graph
PATCH="$1"
ROUNDS="${ROUNDS:-3}"
ARMS="${ARMS:-sum mean values min strmin}"

assert_arm() {
  local want="$1"
  local got
  got=$(grep -c 'foldProjectedNumeric' "$ROOT/packages/gremlin/src/executor/aggregation.ts" || true)

  if [[ "$want" == "post" && "$got" -lt 1 ]]; then
    echo "ARM ASSERTION FAILED: expected POST aggregation.ts to define foldProjectedNumeric, found $got"
    exit 3
  fi

  if [[ "$want" == "pre" && "$got" -ne 0 ]]; then
    echo "ARM ASSERTION FAILED: expected PRE aggregation.ts clean, found $got foldProjectedNumeric lines"
    exit 3
  fi

  echo "# arm=$want verified (foldProjectedNumeric lines: $got)"
}

build() {
  (cd "$ROOT" && bun run build >/dev/null 2>&1)
}

run_arms() {
  local arm="$1"
  local r="$2"
  for s in ${=ARMS}; do
    local line
    line=$(cd "$ROOT/packages/native" && SHAPE=$s bun minmax-prof-1918.mjs 2>&1 | head -1)
    echo "r$r $arm $line"
  done
}

assert_arm post

for r in $(seq 1 "$ROUNDS"); do
  assert_arm post
  build
  run_arms POST "$r"

  (cd "$ROOT" && git apply -R "$PATCH")
  assert_arm pre
  build
  run_arms PRE "$r"

  (cd "$ROOT" && git apply "$PATCH")
done

assert_arm post
build
echo "# restored to POST and rebuilt"
