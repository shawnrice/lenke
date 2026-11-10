#!/usr/bin/env bash
# Interleaved driver for `page-rung-probe.mjs` (item 1775).
#
# ⚠️ ONE SHAPE PER PROCESS, AND THE ARMS INTERLEAVED ACROSS ROUNDS. Item 1367's prescription is
# `p25` per process, median across processes, because the noise on a 200k row is PROCESS-level and
# no within-process estimator removes it. Item 762 is the other half: a two-shape in-process A/B
# flatters any change that redistributes dispatch, which is exactly what a route question is.
#
# Interleaving (round 1: every shape once; round 2: every shape again; …) rather than
# round-by-shape is what keeps a machine that drifts mid-run from being read as an arm difference.
set -u

ROUNDS="${ROUNDS:-5}"
NODES="${NODES:-200000}"
LIMIT="${LIMIT:-10}"
SHAPES="${SHAPES:-list limit orderlimit hoplist hoplimit hoporderlimit offset count hopcount}"

cd "$(dirname "$0")" || exit 1

echo "ROUNDS=$ROUNDS NODES=$NODES LIMIT=$LIMIT"
echo

for r in $(seq 1 "$ROUNDS"); do
  for s in $SHAPES; do
    SHAPE="$s" NODES="$NODES" LIMIT="$LIMIT" bun page-rung-probe.mjs || echo "{\"shape\":\"$s\",\"FAILED\":true}"
  done
done
