#!/bin/zsh
# Item 2031 — is the two-hop rung's 20.9% label share REAL COST or ATTRIBUTION?
#
# ⚠️⚠️ THIS IS A DELETION TEST, NOT A CANDIDATE CHANGE. [[frame-attribution-trap]]: a GETTER frame is
# attribution until a deletion test with a CONTROL says otherwise, and `get labels` (5.0% of the
# profile) is exactly that. [[label-vacuity-gates-fast-paths]] goes further and says the per-edge
# `matchesLabel` dispatch was MEASURED FREE on the edge-driven arm — "a hand arm WITH the dispatch
# measured faster than one without". So the profile's 20.9% is a hypothesis, and this is its oracle.
#
# 🔑 WHY THE ABLATION IS ANSWER-EQUIVALENT HERE, which is what makes it a valid upper bound: the
# probe's fixture gives EVERY vertex label `P`, so `aLabel`/`midEff` are VACUOUS and no vertex is
# excluded by either test. Deleting them cannot change a row. The probe asserts its own answer against
# an independent oracle (item 2030), so a non-equivalent ablation fails loudly instead of measuring
# a different query.
#
# ⚠️ IT IS NOT SHIPPABLE AND MUST NOT BE SHIPPED: on a MIXED graph these tests are necessary work.
# The ABLATE arm is the ceiling any vacuity elision could reach, nothing more.
#
# ⚠️ ARMS NAMED FOR WHAT THEY ARE (LIVE/ABLATE), never PRE/POST (item 2023).
# ⚠️ RESTORE ON ANY EXIT — a kill between the swap and the swap back leaves the tree ablated, which
# still compiles and still passes the homogeneous tests (item 2022's trap).
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/two-hop-filtered-csr.ts
SCRATCH=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad
PRISTINE=$ROOT/crates/lenke-engine/target/two-hop-filtered-csr.pristine.2031.ts
SHAPES=(join hopfilter hopall point)

[[ -f $PRISTINE ]] || cp "$SRC" "$PRISTINE" || exit 1

restore_live() { cp "$PRISTINE" "$SRC" || print -- "[trap] COULD NOT RESTORE"; }
trap restore_live EXIT INT TERM

# ⚠️ START-OF-RUN LIVE CHECK: if a previous kill left the tree ablated, the "LIVE" arm would silently
# be the experiment (item 2023's near-inversion).
cmp -s "$SRC" "$PRISTINE" || { print -- "TREE IS NOT PRISTINE at start — refusing"; exit 1; }

# Both label tests, counted first: an anchor must be unique or the mutant edits more than it claims
# (item 2020).
A_START='    if (aLabel !== undefined && !matchesLabel(a, aLabel)) {'
A_MID='    if (w !== 0 && matchesLabel(order[s], midEff)) {'

for a in "$A_START" "$A_MID"; do
  c=$(grep -cF -- "$a" "$SRC")
  [[ "$c" == "1" ]] || { print -- "ANCHOR NOT UNIQUE ($c): $a"; exit 1; }
done

ablate() {
  cp "$PRISTINE" "$SRC" || exit 1
  # `false &&` keeps both branches syntactically intact — a `//` marker would swallow the line
  # (item 2027's build failure).
  sed -i "s@if (aLabel !== undefined \&\& !matchesLabel(a, aLabel)) {@if (false \&\& aLabel !== undefined \&\& !matchesLabel(a, aLabel)) {@" "$SRC" || exit 1
  sed -i "s@if (w !== 0 \&\& matchesLabel(order\[s\], midEff)) {@if (w !== 0 \&\& (midEff === undefined || true)) {@" "$SRC" || exit 1

  grep -cF 'false && aLabel' "$SRC" | grep -q '^1$' || { print -- "ABLATE ARM NOT SET (start)"; exit 1; }
  grep -cF 'midEff === undefined || true' "$SRC" | grep -q '^1$' || { print -- "ABLATE ARM NOT SET (mid)"; exit 1; }
}

round() {
  case "$1" in
    LIVE) cp "$PRISTINE" "$SRC" || exit 1; cmp -s "$SRC" "$PRISTINE" || exit 1 ;;
    ABLATE) ablate ;;
    RESTORE) restore_live; print -- "restored"; return 0 ;;
  esac

  (cd "$ROOT" && npx nx build @lenke/gql >/dev/null 2>&1) || { print -- "BUILD FAILED: $1"; exit 1; }
  print -- "=== $1 ==="
  for s in "${SHAPES[@]}"; do
    (cd "$ROOT/packages/native" && NODES=20000 FANOUT=3 timeout 900 bun runtime-profile-probe.mjs "$s" 2>&1 | tail -1)
  done
}

round "${ROUND:-}"
