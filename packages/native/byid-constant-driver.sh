#!/usr/bin/env bash
# Item 1737: where does getVertexById's 1.26x over a bare Map.get go?
#
#   base    public getVertexById = (id) => this.verticesById.get(id) ?? null;
#   proto   the same body as a PROTOTYPE METHOD (⚠️ semantic change: loses this-binding when
#           detached, so measurement only unless it proves worth a decision)
#   nonull  `?? null` dropped (⚠️ semantic change: returns undefined for a miss; the probe only
#           looks up ids that exist, so it is a clean ceiling for that branch)
set -u

ROOT=/home/shawn/projects/pl-graph
SRC=$ROOT/packages/core/src/core/Graph.ts
PRISTINE=$ROOT/crates/lenke-engine/target/pristine-1737/Graph.ts
DIST=$ROOT/packages/core/dist/esm/index.mjs

apply_arm() {
  cp "$PRISTINE" "$SRC" || exit 90
  python3 - "$SRC" "$1" <<'PY' || exit 91
import sys
p, arm = sys.argv[1], sys.argv[2]
t = open(p, encoding='utf-8').read()
base = """  public getVertexById = (id: string): Vertex | null => {
    return this.verticesById.get(id) ?? null;
  };
"""
arms = {
  'base': base,
  'proto': """  public getVertexById(id: string): Vertex | null {
    return this.verticesById.get(id) ?? null;
  }
""",
  'nonull': """  public getVertexById = (id: string): Vertex | null => {
    return this.verticesById.get(id) as Vertex | null;
  };
""",
}
assert t.count(base) == 1, f"anchor matched {t.count(base)} times, expected 1"
if arm != 'base':
    open(p, 'w', encoding='utf-8').write(t.replace(base, arms[arm]))
PY
}

assert_dist() {
  local arm="$1" got
  # ⚠️ CLASSIFY FROM THE EMITTED SNIPPET, not from substrings that occur elsewhere in a 500 KB
  # bundle. The first detector tested for `verticesById.get(id);`, which matches some OTHER site, so
  # it reported every arm as `nonull` -- and the assertion then correctly refused to run `base` and
  # `proto` rather than printing numbers for code it could not identify. This takes the 90 characters
  # that FOLLOW the declaration and decides from those.
  # ⚠️ `getVertexById` occurs 26 times in the bundle -- call sites and COMMENT TEXT. A plain `find`
  # lands on a call site, which is why the previous two detectors misclassified every arm. The
  # DECLARATION is the only occurrence matching this regex (verified: exactly 1 match).
  got=$(python3 -c "
import re
t=open('$DIST',encoding='utf-8',errors='replace').read()
ms = list(re.finditer(r'getVertexById\s*=\s*\(|getVertexById\(id\)\s*\{', t))
if len(ms) != 1:
    print(f'AMBIGUOUS-{len(ms)}'); raise SystemExit
snip = t[ms[0].start():ms[0].start()+100]
shape = 'field' if '=' in snip.split('(')[0] else 'proto'
print(shape + ('+nonull' if '??' not in snip else ''))
")
  local want
  case "$arm" in
    base) want=field ;;
    proto) want=proto ;;
    nonull) want=field+nonull ;;
  esac
  if [ "$got" != "$want" ]; then
    echo "ARM-ASSERT-FAILED $arm: dist shape is [$got], expected [$want]"
    return 1
  fi
  echo "arm-assert ok   $arm: dist shape [$got]"
  return 0
}

for round in 1 2 3; do
  for arm in base proto nonull; do
    apply_arm "$arm"
    (cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    assert_dist "$arm" || continue
    for f in engine rawmap; do
      (cd "$ROOT/packages/native" && timeout 900 env ARM="$arm" FIRST="$f" node byid-constant-probe.mjs 2>&1 | tail -1)
    done
  done
done

cp "$PRISTINE" "$SRC"
(cd "$ROOT/packages/core" && bun run build > /dev/null 2>&1)
echo "restored pristine and rebuilt"
