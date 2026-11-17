#!/bin/zsh
# Item 2086 — every corpus shape with HOMOGENEOUS vs MIXED labels, one shape per process.
#
# ⚠️⚠️ **MIXED IS THE REALISTIC MODE AND ALMOST NOTHING HAS BEEN MEASURED IN IT.** A vacuous label is
# ELIDED by `effectiveLabel`, and vacuity is all-or-nothing: one unlabelled vertex defeats the elision
# for every query anchored on that label (item 325's cliff). Item 2085 found `hopfilter` at **5.98x**
# between the two modes and took 2.65x of it back. This asks which OTHER shapes fall off a rung.
#
# ⚠️ A SCREEN RANKS, IT DOES NOT PRICE (CLAUDE.md, and items 2038/2040/2042 each produced a false
# regression signal from a multi-row run). This runs at NODES=20000 to find WHICH shapes the index
# moves at all; anything it flags is then priced at 200,000 in its own A/B.
#
# ⚠️ ONE SHAPE PER PROCESS, because `MIXED=1` changes which ROUTE answers a predicate and a shared
# process would let one shape's route pollute another's dispatch sites (item 762).
#
# THE `answer` FIELD IS ONLY COMPARABLE WHERE `EXPECTED` GUARDS IT, AND THIS SWEEP LEARNED IT THE HARD
# WAY. `hoprows` reported "ANSWER/ROWS DIFFER - WRONG ANSWER" between the modes: 0 against 3, with an
# IDENTICAL `sink`. It is NOT a wrong answer. `MATCH (a:P)-[:E]->(b:P) RETURN b.k` has no `ORDER BY`,
# the two modes take DIFFERENT ROUTES (elided label vs not), and row order is unspecified here - a
# settled WON'T-FIX, compared as multisets. `EXPECTED.hoprows` is `{ rowsPerRun }` with no `answer` for
# exactly that reason.
#
# So: the ROW COUNT (`sink`) is the invariant for EVERY shape, and the `answer` is compared only where
# `EXPECTED` declares one - those are the order-independent ones by construction. Item 2074's sweep
# compared answers unconditionally and reported all 53 identical; that was sound only because its
# shapes happened to be order-independent, a precondition it did not state.
set -u

HERE=/home/shawn/projects/pl-graph/packages/native
N=${NODES:-200000}
REPS=${REPS:-7}

shapes=$(python3 - <<'PY'
import io, re
s = io.open('/home/shawn/projects/pl-graph/packages/native/runtime-profile-probe.mjs', encoding='utf-8').read()
i = s.index('const SHAPES = {')
j = s.index('\n};', i)
print(' '.join(re.findall(r"^  ([a-z][a-z0-9]*):\s*['\"]", s[i:j], re.M)))
PY
)

print -- "#  ${#${(z)shapes}} shapes, NODES=$N, REPS=$REPS, one shape per process\n"
printf "  %-18s %10s %10s %8s  %s\n" shape plain MIXED ratio answers

# ⚠️⚠️ THE JSON IS PARSED, NOT PATTERN-MATCHED. The first form of this loop extracted the answer with
# "answer":[-0-9]+, which silently dropped FIVE of 53 shapes -- `point` answers "s345" (a string) and
# `collected` answers an ARRAY. They reported "THREW or no match", which reads as a broken shape rather
# than a broken reader. A screen that silently covers 48 of 53 rows is the failure this file exists to
# avoid, so the comparison now goes through `json.loads`.
# THE SIZE IS THE WHOLE POINT, AND THE FIRST RUN OF THIS SWEEP WAS AT THE WRONG ONE. At NODES=20000
# `hopfilter` reads 0.78x between the modes; at 200,000 item 2085 measured 5.98x. The elision's
# absence costs a CACHE MISS per candidate, so a 20,000-vertex screen cannot see the effect it exists
# to find. Default raised, and `SHAPES=` narrows the list when the slow shapes make a full run
# impractical.
for sh in ${(z)${SHAPES:-$shapes}}; do
  plain=$(cd "$HERE" && NODES=$N timeout 900 bun runtime-profile-probe.mjs "$sh" "$REPS" 2>/dev/null | grep -oE '\{"shape".*' | tail -1)
  idx=$(cd "$HERE" && MIXED=1 NODES=$N timeout 900 bun runtime-profile-probe.mjs "$sh" "$REPS" 2>/dev/null | grep -oE '\{"shape".*' | tail -1)

  PLAIN="$plain" IDX="$idx" SH="$sh" python3 - <<'PYEOF'
import json, os

sh = os.environ['SH']
raw_p, raw_i = os.environ['PLAIN'], os.environ['IDX']

if not raw_p or not raw_i:
    print(f"  {sh:<18} {'-':>10} {'-':>10} {'-':>8}  THREW — no JSON line")
else:
    p, i = json.loads(raw_p), json.loads(raw_i)
    guarded = sh in os.environ.get('GUARDED', '').split()
    rows_same = p['sink'] == i['sink']

    if not rows_same:
        note = 'ROW COUNT DIFFERS - WRONG ANSWER, not a speed result'
    elif not guarded:
        # No `answer` guard means the value is order-dependent; the row count is the real invariant.
        note = f"rows same ({p['sink']}), answer not comparable"
    elif p['answer'] == i['answer']:
        note = f"same ({json.dumps(p['answer'])[:28]})"
    else:
        note = f"ANSWER DIFFERS on a GUARDED shape - WRONG ANSWER: {p['answer']!r} vs {i['answer']!r}"

    ratio = f"{p['ms'] / i['ms']:.2f}x" if i['ms'] else 'n/a'
    print(f"  {sh:<18} {p['ms']:>10} {i['ms']:>10} {ratio:>8}  {note}")
PYEOF
done
