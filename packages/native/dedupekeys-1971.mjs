// Item 1971 — WHAT DOES `dedupe().by(k).values(w)` ACTUALLY ANSWER when keys are missing?
//
// Item 1970 priced that shape at 2.07x its `.values(k)` sibling (524 against 253 ns a visit, ~271 ms
// absolute) and called it a build. Before building: `hop-values-dedupe.ts` declines it ON PURPOSE —
// "keeps the first element per `n` and projects `k` off it, which is NOT the distinct `k` values" —
// and the same header records that **items 1561/1562 each found a silent ANSWER change in this
// area**, warning that a second keyer here "would be the third".
//
// 🔑 SO THE ORACLE HAS TO BE ESTABLISHED FIRST, and the generic pipeline is it: whatever a fused arm
// does, it must reproduce the route that runs today, which is also the route native agrees with.
// The question a fused arm cannot guess is MISSING KEYS, and there are four cases:
//
//     both present    the ordinary row
//     `w` missing     `values('w')` emits nothing — but was the element still CONSUMED for dedupe?
//     `k` missing     what does `dedupe().by('k')` do with an element that has no `k`?
//     both missing    the two interacting
//
// ⚠️ AND THE ANSWER IS COMPARED AGAINST NATIVE, because a fused arm has to match the engine
// contract, not just the TS pipeline. If the two already disagree here, that is a finding of its own
// and the build stops.
//
//     bun dedupekeys-1971.mjs
import { Graph } from '@lenke/core';
import { dedupe, out, toArray, traversal, V, values } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

/*
 * Twelve far vertices covering the four cases, each reachable from its own start so every one is
 * actually visited. `k` is the DEDUPE key and `w` the PROJECTED one.
 *
 *   f1  k=1 w=10      f2  k=1 w=11      <- same k: f2 must be dropped, so w=11 never appears
 *   f3  k=2 w=NO w              <- k present, w ABSENT
 *   f4  k=NO k w=12             <- k ABSENT, w present
 *   f5  k=3 w=13
 *   f6  k=NO k w=14             <- a second k-absent element: is it deduped against f4?
 *   f7  k=2 w=15                <- same k as f3, whose w was absent
 */
// ⚠️ OBJECTS, NOT TUPLES: a mixed tuple array gives `id` the union `string | object` in a `.mjs`,
// where there is no annotation to narrow it, and the stringification lint is right to object.
const FAR = [
  { id: 'f1', props: { k: 1, w: 10 } },
  { id: 'f2', props: { k: 1, w: 11 } },
  { id: 'f3', props: { k: 2 } },
  { id: 'f4', props: { w: 12 } },
  { id: 'f5', props: { k: 3, w: 13 } },
  { id: 'f6', props: { w: 14 } },
  { id: 'f7', props: { k: 2, w: 15 } },
];

const lines = [];

for (const { id, props } of FAR) {
  lines.push(`{"type":"node","id":"${id}","labels":["T"],"properties":${JSON.stringify(props)}}`);
}

for (const [i, { id }] of FAR.entries()) {
  lines.push(`{"type":"node","id":"s${String(i)}","labels":["T"],"properties":{"k":99,"w":99}}`);
  lines.push(
    `{"type":"edge","id":"e${String(i)}","labels":["E"],"from":"s${String(i)}","to":"${id}","properties":{}}`,
  );
}

const NDJSON = lines.join('\n');
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

const SHAPES = [
  [
    'dedupe.by(k).values(w)  [the target]',
    () => traversal(V(), out('E'), dedupe().by('k'), values('w')),
  ],
  [
    'dedupe.by(k).values(k)  [fused today]',
    () => traversal(V(), out('E'), dedupe().by('k'), values('k')),
  ],
  ['values(w).dedupe()      [fused today]', () => traversal(V(), out('E'), values('w'), dedupe())],
  ['values(k).dedupe()      [fused today]', () => traversal(V(), out('E'), values('k'), dedupe())],
];

const nativeGraph = nativeReady ? graphFromNdjson(nativeBackend(), NDJSON) : undefined;

console.log(
  '# far vertices: f1(k1,w10) f2(k1,w11) f3(k2,-) f4(-,w12) f5(k3,w13) f6(-,w14) f7(k2,w15)',
);
console.log('# every start carries k=99,w=99 and is NOT a far vertex\n');

for (const [name, build] of SHAPES) {
  const ts = JSON.stringify(toArray(build(), tsGraph));

  console.log(`${name.padEnd(40)} ts=${ts}`);
}

if (nativeGraph === undefined) {
  console.log('\nSKIP native: the engine library is not built');
} else {
  console.log('');

  // ⚠️ NATIVE TAKES TEXT, so the same shapes are written as Gremlin source. A mismatch between the
  // two renderings would compare different questions, so the text mirrors the builders above.
  const TEXTS = [
    ['dedupe.by(k).values(w)', "g.V().out('E').dedupe().by('k').values('w')"],
    ['dedupe.by(k).values(k)', "g.V().out('E').dedupe().by('k').values('k')"],
    ['values(w).dedupe()', "g.V().out('E').values('w').dedupe()"],
    ['values(k).dedupe()', "g.V().out('E').values('k').dedupe()"],
  ];

  for (const [name, text] of TEXTS) {
    try {
      console.log(`${name.padEnd(40)} native=${JSON.stringify(nativeGraph.gremlin(text))}`);
    } catch (e) {
      console.log(`${name.padEnd(40)} native=THREW ${String(e.message).slice(0, 70)}`);
    }
  }
}
