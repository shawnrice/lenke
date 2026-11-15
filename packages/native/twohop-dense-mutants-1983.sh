#!/bin/zsh
# Item 1983 — mutation round on the two-hop dense route and its gate.
#
# ⚠️ RUN FROM THE REPO ROOT: `zsh packages/native/twohop-dense-mutants-1983.sh`.
#
# The route is ANSWER-EQUIVALENT, so the 2,419-test Gremlin suite and all seven byte-identity
# fuzzers are blind to a gate mutant — both arms count the same walks. The gate test is what must
# catch those; the route's own arithmetic is what the answer tests must catch. This runs each mutant
# under both and reports which one caught it.
#
# ⚠️ EVERY MUTANT UNDER A TIMEOUT AND A MEMORY CAP. A mutant here can make a frontier loop
# non-terminating or allocate a Float64Array per pass without bound; 124 or 137 IS the catch.
#
# ⚠️ VERDICT READS STDOUT+STDERR, NOT THE EXIT CODE ALONE — `bun test` reports to STDERR.
set -u

SRC=packages/gremlin/src/executor/count-shortcut.ts
PRISTINE=crates/lenke-engine/target/post-countshortcut-1983.ts
STAMP=$(date +%s)
LOG=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad/mutants-1983-$STAMP.log
touch "$LOG"

typeset -a MUTANTS
MUTANTS=(
  # ---- the gate (expected: caught by the GATE test) ----
  "gate-admits-both|hops[0].kind !== 'both' && oneWalkThroughout(hops)|oneWalkThroughout(hops)"
  "gate-drops-onewalk|hops[0].kind !== 'both' && oneWalkThroughout(hops) && hops[0].labels.length === 1|hops[0].kind !== 'both' && hops[0].labels.length === 1"
  "gate-drops-single-label|oneWalkThroughout(hops) && hops[0].labels.length === 1|oneWalkThroughout(hops)"
  "gate-always-true|hops[0].kind !== 'both' && oneWalkThroughout(hops) && hops[0].labels.length === 1|true"
  "gate-always-false|hops[0].kind !== 'both' && oneWalkThroughout(hops) && hops[0].labels.length === 1|false"
  # ---- the call site (a mutant dropping the second-ask half is EXPECTED to survive; see the note
  #      on `twoHopDenseShape` — it is caught by `twohop-coldask-1983.mjs`, not by a test) ----
  "callsite-drops-second-ask|twoHopDenseShape(hops) && seenBefore(graph, h0.kind === 'out', h0.labels[0])|twoHopDenseShape(hops)"
  "callsite-wrong-direction|seenBefore(graph, h0.kind === 'out', h0.labels[0])|seenBefore(graph, h0.kind !== 'out', h0.labels[0])"
  # ---- the route's own arithmetic (expected: caught by the ANSWER tests) ----
  "route-seeds-empty|denseChainCount(hops, [...graph.verticesById.values()], graph)|denseChainCount(hops, [], graph)"
)

print "item 1983 mutation round, $STAMP" | tee -a "$LOG"

for entry in "${MUTANTS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  from="${rest%%|*}"
  to="${rest#*|}"

  # RESTORE BEFORE APPLYING, never only after the loop.
  cp "$PRISTINE" "$SRC"

  applied=$(FROM="$from" TO="$to" SRC="$SRC" python3 -c '
import io, os
p = os.environ["SRC"]
s = io.open(p, encoding="utf-8").read()
f = os.environ["FROM"]
t = os.environ["TO"]
n = s.count(f)
if n == 1:
    io.open(p, "w", encoding="utf-8").write(s.replace(f, t, 1))
print(n)
')

  if [[ "$applied" != "1" ]]; then
    print "MUTANT $name  ANCHOR-BAD matches=$applied  <- not a verdict, fix the anchor" | tee -a "$LOG"
    continue
  fi

  gate=$(cd packages/gremlin && timeout 300 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
    bun test src/executor/two-hop-dense-count.test.ts 2>&1)
  gate_rc=$?
  ans=$(cd packages/gremlin && timeout 600 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
    bun test 2>&1)
  ans_rc=$?

  gate_ran=$(print -r -- "$gate" | grep -cE '[0-9]+ (pass|fail)')
  ans_ran=$(print -r -- "$ans" | grep -cE '[0-9]+ (pass|fail)')
  gate_fail=$(print -r -- "$gate" | grep -oE '[0-9]+ fail' | head -1)
  ans_fail=$(print -r -- "$ans" | grep -oE '[0-9]+ fail' | head -1)

  verdict="SURVIVED"
  if [[ $gate_rc -eq 124 || $gate_rc -eq 137 || $ans_rc -eq 124 || $ans_rc -eq 137 ]]; then
    verdict="CAUGHT(timeout/oom gate=$gate_rc ans=$ans_rc)"
  elif [[ "$gate_ran" == "0" || "$ans_ran" == "0" ]]; then
    verdict="DID-NOT-RUN(gate_ran=$gate_ran ans_ran=$ans_ran)"
  elif [[ "$gate_fail" != "0 fail" && -n "$gate_fail" ]]; then
    verdict="CAUGHT-BY-GATE($gate_fail)"
  elif [[ "$ans_fail" != "0 fail" && -n "$ans_fail" ]]; then
    verdict="CAUGHT-BY-ANSWERS($ans_fail)"
  fi

  print "MUTANT $name  $verdict" | tee -a "$LOG"
done

cp "$PRISTINE" "$SRC"
print "restored; log at $LOG" | tee -a "$LOG"
