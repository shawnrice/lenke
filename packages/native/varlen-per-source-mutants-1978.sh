#!/bin/zsh
# Item 1978 — mutation round on the per-source route and its gate.
#
# A route choice is ANSWER-EQUIVALENT, so the parity and differential suites cannot see a mutant of
# the gate: both routes return the same count. The gate test has to catch those, and the route's own
# arms (position marking, the min-0 term, the budget) have to be caught by the answer tests. This
# runs each mutant under BOTH suites and reports which one caught it.
#
# ⚠️ EVERY MUTANT RUNS UNDER A TIMEOUT AND A MEMORY CAP. A mutant here is arbitrary broken code in a
# RECURSIVE enumeration with a budget that a mutant can remove — non-termination and unbounded
# allocation are the normal case, not the exception. 124 or 137 IS the catch.
#
# ⚠️ AND THE VERDICT READS STDOUT+STDERR, NOT THE EXIT CODE ALONE. `bun test` reports `N pass` to
# STDERR; items 767 and 772/773 each got this wrong in opposite directions.
set -u

# ⚠️ RUN FROM THE REPO ROOT: `zsh packages/native/varlen-per-source-mutants-1978.sh`. The paths below
# are repo-relative, which is what lets one script drive both the gql suites and the pristine copy
# under `crates/lenke-engine/target/` (gitignored, and it survives the reboot a runaway mutant can
# force).
SRC=packages/gql/src/executor/var-length-count.ts
PRISTINE=crates/lenke-engine/target/post-varlen-1978.ts
STAMP=$(date +%s)
LOG=/tmp/claude-1000/-home-shawn-projects-pl-graph/d06c85fd-9834-4f74-aceb-aa3f731dd30d/scratchpad/mutants-1978-$STAMP.log
touch "$LOG"

# name | python-replace-from | python-replace-to
typeset -a MUTANTS
MUTANTS=(
  "gate-drops-seed-requirement|seeded && sources > 0|sources > 0"
  "gate-inverted|sources * PER_SOURCE_MIN_RATIO <= vertices|sources * PER_SOURCE_MIN_RATIO > vertices"
  "gate-always-true|seeded && sources > 0 && sources * PER_SOURCE_MIN_RATIO <= vertices|true"
  "gate-admits-empty-src|seeded && sources > 0|seeded"
  "ratio-to-one|const PER_SOURCE_MIN_RATIO = 8|const PER_SOURCE_MIN_RATIO = 1"
  "budget-zero|levels * (vertices + edges)|0"
  "budget-unbounded|levels * (vertices + edges)|Number.MAX_SAFE_INTEGER"
  "trail-marks-neighbours|used.add(k);|used.add(nbr[k]);"
  "trail-no-mark|      used.add(k);|      void k;"
  "trail-drops-min-gate|len >= 1 && len >= min|len >= 1"
  "walk-drops-min-gate|      if (len >= min) {|      if (true) {"
  "walk-min0-dropped|    if (min === 0 && passes(s)) {\n      total += 1;\n    }\n\n    let frontier|    let frontier"
  "walk-overwrites-multiplicity|next.set(w, (next.get(w) ?? 0) + c);|next.set(w, c);"
)

print "item 1978 mutation round, $STAMP" | tee -a "$LOG"

for entry in "${MUTANTS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  from="${rest%%|*}"
  to="${rest#*|}"

  # RESTORE BEFORE APPLYING, never only after the loop — an interrupted run must not leave a
  # mutant in the tree.
  cp "$PRISTINE" "$SRC"

  applied=$(FROM="$from" TO="$to" SRC="$SRC" python3 -c '
import io, os
p = os.environ["SRC"]
s = io.open(p, encoding="utf-8").read()
f = os.environ["FROM"].encode().decode("unicode_escape")
t = os.environ["TO"].encode().decode("unicode_escape")
n = s.count(f)
if n == 1:
    io.open(p, "w", encoding="utf-8").write(s.replace(f, t, 1))
print(n)
')

  if [[ "$applied" != "1" ]]; then
    print "MUTANT $name  ANCHOR-BAD matches=$applied  <- not a verdict, fix the anchor" | tee -a "$LOG"
    continue
  fi

  gate=$(cd packages/gql && timeout 300 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
    bun test src/var-length-per-source-gate.test.ts 2>&1)
  gate_rc=$?
  ans=$(cd packages/gql && timeout 300 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
    bun test src/trail-count-bruteforce.test.ts src/trail-three-hop-count.test.ts src/varlen-depth4-vacuous.test.ts 2>&1)
  ans_rc=$?

  # EVIDENCE OF EXECUTION FIRST, then the exit code.
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
