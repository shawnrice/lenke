#!/bin/zsh
# Run `bun run fuzz` N times and KEEP THE OUTPUT OF ANY FAILING RUN.
#
# **THIS EXISTS BECAUSE I DESTROYED THE EVIDENCE TWICE.** Item 2005 piped a 16-minute mutation
# round through `tail`, which buffers until exit, so a progress file stayed empty and "working" was
# indistinguishable from "wedged". Item 2011 then piped each fuzz run through
# `grep -oE "pass|fail"` — so when one sweep in four actually FAILED, the only thing left was the
# word "fail". Which fuzzer, which seed, which query: gone. It did not reproduce in 49 later runs, so
# that failure is now permanently unattributable.
#
# **A LOOP THAT EXISTS TO CATCH A RARE FAILURE MUST KEEP THE FAILING RUN'S OUTPUT, NOT ITS TALLY.**
# The tally is what you already expect; the output is the only thing worth having when the
# expectation breaks.
#
# AND THE SEED IS THE PRIZE. Every fuzzer in this repo prints a replay line — the differential one
# emits `FUZZ_SEED=<n> bun test <file> to reproduce`. A captured seed turns a 1-in-20 ghost into a
# deterministic test case, which is exactly how item 2005's `{0,k}` wrong answer got fixed.
#
#     zsh fuzz-sweep.sh            # 10 sweeps
#     N=25 zsh fuzz-sweep.sh       # 25
#     N=10 ONE=differential zsh fuzz-sweep.sh   # one fuzzer, 10 times
set -u

ROOT=/home/shawn/projects/pl-graph
N=${N:-10}
ONE=${ONE:-}
OUT=${OUT:-$ROOT/crates/lenke-engine/target/fuzz-sweep-$(date +%s)}

mkdir -p "$OUT" || exit 1
print -- "sweeping ${N}x${ONE:+ ($ONE)}; failures land in $OUT"

fails=0

for i in $(seq 1 "$N"); do
  # `--no-build` ON PURPOSE: the caller builds once. Rebuilding per run is what made item 2005's
  # round take 38 minutes, and a stale artifact is the OTHER trap — so build before calling this.
  out=$(cd "$ROOT/packages/native" && timeout 2400 bun run fuzz ${ONE:+$ONE} --no-build 2>&1)
  rc=$?
  # The result line is the EXECUTION evidence, and `bun test` writes it to STDERR (CLAUDE.md) — both
  # streams are already merged above, so look for it here rather than trusting the exit code alone.
  ran=$(print -- "$out" | grep -cE '^ *[0-9]+ (pass|fail)')

  if [[ "$ran" == "0" ]]; then
    print -- "run $i: DID-NOT-RUN (no result line) — output kept"
    print -- "$out" >| "$OUT/run-$i-did-not-run.log"
    fails=$((fails + 1))
    continue
  fi

  if [[ "$rc" != "0" ]]; then
    fails=$((fails + 1))
    print -- "$out" >| "$OUT/run-$i-FAIL.log"
    print -- "run $i: FAIL (exit $rc) — full output in $OUT/run-$i-FAIL.log"
    # The three things worth seeing immediately: which file, which case, which seed.
    print -- "$out" | grep -E '^src/|\(fail\)|FUZZ_SEED|\[seed ' | head -8 | sed 's/^/    /'
    continue
  fi

  printf '%s ' "$i"
done

# `${fails:+…}` TESTS EMPTINESS, NOT TRUTH — and `"0"` is non-empty, so it printed "see <dir>"
# on a clean sweep and pointed at an empty directory. A numeric test is the one that means what it
# looks like.
if (( fails > 0 )); then
  print -- "\n$((N - fails))/$N clean, $fails failing — see $OUT"
else
  print -- "\n$N/$N clean"
  rmdir "$OUT" 2>/dev/null
fi
exit $((fails > 0 ? 1 : 0))
