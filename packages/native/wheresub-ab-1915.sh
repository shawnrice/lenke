#!/bin/zsh
# Item 1915 — interleaved PRE/POST A/B for the sub-plan-existence fusion.
#
# WHY THIS EXISTS RATHER THAN TWO SINGLE RUNS. The first POST measurement showed both CONTROLS
# moving AGAINST the change — the plain hop 41.49 -> 45.21 and the bare scan 4.17 -> 4.95 — and
# `dispatch.ts` is the central 103-arm dispatcher, so a real perturbation is plausible
# ([[executor-edits-perturb]]: up to 16% on unrelated rows). CLAUDE.md: single-run against
# single-run has not survived repetition here before.
#
# EACH ARM ASSERTS IT IS THE CODE IT CLAIMS BEFORE MEASURING. CLAUDE.md records an A/B where one
# of the two files was never written, so the "after" reading was the "before" code — a null that
# looks like a result. `hopExistence` must appear in `dispatch.ts` exactly in POST and never in PRE,
# and a mismatch exits non-zero instead of measuring.
set -e
set -u

ROOT=/home/shawn/projects/pl-graph
PATCH="$1"
ROUNDS="${ROUNDS:-3}"
ARMS="${ARMS:-hop scan where wherecnt not and filter}"

assert_arm() {
  local want="$1"
  local got
  got=$(grep -c 'hopExistence' "$ROOT/packages/gremlin/src/executor/dispatch.ts" || true)

  if [[ "$want" == "post" && "$got" -lt 5 ]]; then
    echo "ARM ASSERTION FAILED: expected POST dispatch.ts to use hopExistence, found $got lines"
    exit 3
  fi

  if [[ "$want" == "pre" && "$got" -ne 0 ]]; then
    echo "ARM ASSERTION FAILED: expected PRE dispatch.ts to be clean, found $got hopExistence lines"
    exit 3
  fi

  echo "# arm=$want verified (hopExistence lines in dispatch.ts: $got)"
}

build() {
  (cd "$ROOT" && bun run build >/dev/null 2>&1)
}

run_arms() {
  local arm="$1"
  local r="$2"
  for s in ${=ARMS}; do
    local line
    line=$(cd "$ROOT/packages/native" && SHAPE=$s bun wheresub-prof-1915.mjs 2>&1 | head -1)
    echo "r$r $arm $line"
  done
}

# Start from POST (the working tree as edited).
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
