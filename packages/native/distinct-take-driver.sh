#!/usr/bin/env bash
# Item 1738: what is inside `take`'s 60.6% on `RETURN DISTINCT n.k AS k`?
#
# ⚠️ BOTH NON-BASE ARMS ARE CEILINGS, NOT CANDIDATES -- they break the answer on purpose. The
# question is attribution: a profile gave `take` 60.6% SELF with `propOf` 8.7%, `add` 9.7% and
# `get properties` 5.7% as separate frames, which is implausible for a body that is two branches, a
# property read, a set add and a conditional push. V8 charges inlined callees to the caller frame,
# so the split has to be settled by deletion.
#
#   base      as shipped
#   constrow  pushes a PREBUILT object instead of `{ [outName]: value }` -> the computed-key
#             literal's share. Row count and `sink` unchanged.
#   novalue   `propOf`/`evalFn` replaced by a counter mod 97 -> the property read's share. The
#             modulus is the fixture's own cardinality, so the DEDUP and the PUSH do the same work
#             as base; replacing it with a constant would have collapsed 97 rows to 1 and measured
#             the push too.
#
# ⚠️ Both preserve a NON-ZERO `sink`, because the probe throws when a shape returns nothing -- an
# assertion worth keeping rather than defeating.
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/gql/src/executor/hop-projection.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1738/hop-projection.ts
DIST=$ROOT/packages/gql/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  python3 - "$SRC" "$1" <<'PY' || exit 91
import sys
p, arm = sys.argv[1], sys.argv[2]
t = open(p, encoding='utf-8').read()

val = """      const value = directKey === undefined ? evalFn(env) : propOf(el, directKey);

      if (seen.add(value)) {
        rows.push({ [outName]: value });
      }"""

if arm == 'base':
    pass
elif arm == 'constrow':
    assert t.count(val) == 1, f"anchor matched {t.count(val)} times"
    t = t.replace(val, """      const value = directKey === undefined ? evalFn(env) : propOf(el, directKey);

      if (seen.add(value)) {
        rows.push(ablateRow);
      }""")
    pair = "    const seen = valueSet();\n    const rows: Row[] = [];"
    assert t.count(pair) == 1, f"decl anchor matched {t.count(pair)} times"
    t = t.replace(pair, pair + "\n    const ablateRow = { [outName]: 0 } as Row;")
elif arm == 'novalue':
    assert t.count(val) == 1, f"anchor matched {t.count(val)} times"
    t = t.replace(val, """      ablateCtr = (ablateCtr + 1) % 97;
      const value = ablateCtr as unknown;

      if (seen.add(value)) {
        rows.push({ [outName]: value });
      }""")
    pair = "    const seen = valueSet();\n    const rows: Row[] = [];"
    assert t.count(pair) == 1, f"decl anchor matched {t.count(pair)} times"
    t = t.replace(pair, pair + "\n    let ablateCtr = 0;")
else:
    raise SystemExit(f"unknown arm {arm}")

if arm != 'base':
    open(p, 'w', encoding='utf-8').write(t)
PY
}

assert_dist() {
  local arm="$1" got
  # Keyed on the DECLARATION's body, not on a symbol name: item 1737 burned two detectors that
  # matched call sites and carried-through comment text in the bundle.
  got=$(python3 -c "
t=open('$DIST',encoding='utf-8',errors='replace').read()
# POSITION-IMPLYING ANCHORS, not proximity. Three detectors have now failed by keying on the FIRST
# occurrence of a name: this file has TWO take closures (a count path and a rows path) and the count
# one is emitted first, so a proximity check around the take declaration measured the closure that
# was never mutated. Instead, assert on text that can ONLY exist if the mutation landed in the right
# body: the rewritten push, and the rewritten value expression.
# NOTE: no backticks in here. This block sits inside a double-quoted python3 -c string, where a
# backtick is COMMAND SUBSTITUTION; the first version printed 'take: command not found' per run.
has_row = 'rows.push(ablateRow)' in t and 'ablateRow = {' in t
has_ctr = 'ablateCtr = (ablateCtr + 1) % 97' in t and 'let ablateCtr = 0' in t
print('constrow' if has_row else 'novalue' if has_ctr else 'base')")
  if [ "$got" != "$arm" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist shape is [$got], expected [$arm]"
    return 1
  fi
  echo "arm-assert ok   $arm"
  return 0
}

for round in 1 2; do
  for arm in base constrow novalue; do
    apply_arm "$arm"
    (cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for run in 1 2; do
      printf '%s ' "$arm"
      (cd "$ROOT/packages/native" && timeout 900 node runtime-profile-probe.mjs distinct 2000 2>&1 | tail -1)
    done
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
