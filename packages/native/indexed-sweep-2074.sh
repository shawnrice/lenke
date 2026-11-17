#!/bin/zsh
# Item 2074 — every corpus shape with and without the index, one shape per process.
#
# ⚠️ A SCREEN RANKS, IT DOES NOT PRICE (CLAUDE.md, and items 2038/2040/2042 each produced a false
# regression signal from a multi-row run). This runs at NODES=20000 to find WHICH shapes the index
# moves at all; anything it flags is then priced at 200,000 in its own A/B.
#
# ⚠️ ONE SHAPE PER PROCESS, because `INDEXED=1` changes which ROUTE answers a predicate and a shared
# process would let one shape's route pollute another's dispatch sites (item 762).
#
# ⚠️ THE ANSWER IS COMPARED, NOT JUST THE TIME. An index must not change a single row: the probe's own
# oracle already throws on a row-count change, and this additionally compares the `answer` field
# between the two arms. A shape whose answer moves is a WRONG ANSWER, not a speed finding.
set -u

HERE=/home/shawn/projects/pl-graph/packages/native
N=${NODES:-20000}
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
printf "  %-18s %10s %10s %8s  %s\n" shape plain indexed ratio answers

# ⚠️⚠️ THE JSON IS PARSED, NOT PATTERN-MATCHED. The first form of this loop extracted the answer with
# "answer":[-0-9]+, which silently dropped FIVE of 53 shapes -- `point` answers "s345" (a string) and
# `collected` answers an ARRAY. They reported "THREW or no match", which reads as a broken shape rather
# than a broken reader. A screen that silently covers 48 of 53 rows is the failure this file exists to
# avoid, so the comparison now goes through `json.loads`.
for sh in ${(z)shapes}; do
  plain=$(cd "$HERE" && NODES=$N timeout 900 bun runtime-profile-probe.mjs "$sh" "$REPS" 2>/dev/null | grep -oE '\{"shape".*' | tail -1)
  idx=$(cd "$HERE" && INDEXED=1 NODES=$N timeout 900 bun runtime-profile-probe.mjs "$sh" "$REPS" 2>/dev/null | grep -oE '\{"shape".*' | tail -1)

  PLAIN="$plain" IDX="$idx" SH="$sh" python3 - <<'PYEOF'
import json, os

sh = os.environ['SH']
raw_p, raw_i = os.environ['PLAIN'], os.environ['IDX']

if not raw_p or not raw_i:
    print(f"  {sh:<18} {'-':>10} {'-':>10} {'-':>8}  THREW — no JSON line")
else:
    p, i = json.loads(raw_p), json.loads(raw_i)
    same = p['answer'] == i['answer'] and p['sink'] == i['sink']
    note = f"same ({json.dumps(p['answer'])[:28]})" if same else (
        f"⚠️ ANSWER/ROWS DIFFER — WRONG ANSWER, not a speed result"
    )
    ratio = f"{p['ms'] / i['ms']:.2f}x" if i['ms'] else 'n/a'
    print(f"  {sh:<18} {p['ms']:>10} {i['ms']:>10} {ratio:>8}  {note}")
PYEOF
done
