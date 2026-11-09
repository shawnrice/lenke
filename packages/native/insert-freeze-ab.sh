#!/usr/bin/env bash
# Item 1764: what does `Object.freeze` cost an INSERT? Item 1733 priced it at 30% of a property
# WRITE and left the lazy-freeze decision open; this is the second shape, and the profile puts
# #commitNormalized at 17.9% of a parameterised INSERT.
set -u
R=/home/shawn/projects/pl-graph
P=$R/crates/lenke-engine/target/pristine-1733
S=$R/packages/core/src/core/Vertex.ts
D=$R/packages/core/dist/esm/index.mjs
for round in 1 2 3; do
  for arm in base nofreeze; do
    cp "$P/Vertex.ts" "$S"
    [ "$arm" = nofreeze ] && sed -i 's/const frozen = Object\.freeze(bag);/const frozen = bag;/' "$S"
    (cd "$R/packages/core" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED $arm"; continue; }
    (cd "$R/packages/gql" && bun run build > /dev/null 2>&1) || { echo "BUILD-FAILED gql"; continue; }
    want=2; [ "$arm" = nofreeze ] && want=1
    got=$(python3 -c "
t=open('$D',encoding='utf-8',errors='replace').read()
print(t.count('freeze(bag)'))
")
    [ "$got" = "$want" ] || { echo "ARM-ASSERT-FAILED $arm: freeze(bag)=$got want=$want"; continue; }
    echo "arm-assert ok   $arm"
    for s in insertp setp; do
      printf '%s ' "$arm"
      (cd "$R/packages/native" && timeout 600 env SHAPE="$s" INDEXED=1 BATCH=20000 node gql-write-probe.mjs 2>&1 | tail -1 | sed 's/.*"shape"/"shape"/;s/"seed":2000,"batch":20000,//;s/,"series.*//')
    done
  done
done
cp "$P/Vertex.ts" "$S"
(cd "$R/packages/core" && bun run build > /dev/null 2>&1); (cd "$R/packages/gql" && bun run build > /dev/null 2>&1)
echo "restored pristine"
